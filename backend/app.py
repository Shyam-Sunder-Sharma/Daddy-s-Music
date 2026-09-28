import os
import sys

# Prevent Python from writing .pyc files in the workspace folder (which triggers Live Server)
sys.dont_write_bytecode = True

import time
import shutil
import threading
import sqlite3
import requests
from flask import Flask, request, jsonify, Response, g, send_from_directory
from flask_cors import CORS
import yt_dlp

from auth import auth_bp, init_auth_db, require_auth

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))
if not os.path.isdir(FRONTEND_DIR):
    FRONTEND_DIR = BASE_DIR

ALLOWED_FRONTEND_FILES = {"index.html", "styles.css", "app.js", "auth-gate.js"}

@app.route('/')
def serve_index():
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route('/<path:filename>')
def serve_frontend(filename):
    if filename in ALLOWED_FRONTEND_FILES:
        return send_from_directory(FRONTEND_DIR, filename)
    return jsonify({'error': 'Not found'}), 404

app.register_blueprint(auth_bp)

# Store the database file in a separate hidden directory outside the workspace
# so file watchers (VS Code Live Server / OneDrive) NEVER trigger a browser reload
DATA_DIR = os.path.join(os.path.expanduser("~"), ".daddys_music_data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "music.db")

# Automatically migrate legacy workspace music.db if present and remove it from workspace
for legacy_db in [
    os.path.abspath(os.path.join(BASE_DIR, "..", "music.db")),
    os.path.abspath(os.path.join(BASE_DIR, "music.db")),
]:
    if os.path.isfile(legacy_db):
        try:
            if not os.path.isfile(DB_PATH) or os.path.getsize(legacy_db) > os.path.getsize(DB_PATH):
                shutil.copy2(legacy_db, DB_PATH)
            os.remove(legacy_db)
        except Exception as e:
            print("Legacy DB cleanup note:", e)

STREAM_CACHE = {}
CACHE_TTL = 3600 * 4

FALLBACK_APIS = [
    "https://pipedapi.kavin.rocks",
    "https://api.piped.privacydev.net",
    "https://piped-api.lunar.icu"
]

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            title TEXT,
            artist TEXT,
            thumbnail TEXT,
            duration INTEGER
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS favorites (
            user_id INTEGER,
            track_id TEXT,
            PRIMARY KEY (user_id, track_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (track_id) REFERENCES tracks(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlists (
            id TEXT PRIMARY KEY,
            user_id INTEGER,
            name TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id TEXT,
            track_id TEXT,
            position INTEGER,
            PRIMARY KEY (playlist_id, track_id),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id),
            FOREIGN KEY (track_id) REFERENCES tracks(id)
        )
    ''')
    conn.commit()
    conn.close()

init_db()
init_auth_db(DB_PATH)

def upsert_track(cursor, track):
    if not track or 'id' not in track:
        return
    duration = track.get('dur') or track.get('duration') or 0
    cursor.execute('''
        INSERT OR REPLACE INTO tracks (id, title, artist, thumbnail, duration)
        VALUES (?, ?, ?, ?, ?)
    ''', (str(track['id']), track.get('title'), track.get('artist'), track.get('thumbnail'), int(duration)))

@app.route('/api/sync/load', methods=['GET'])
@require_auth
def sync_load():
    user_id = g.current_user['id']
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT t.* FROM tracks t
        JOIN favorites f ON t.id = f.track_id
        WHERE f.user_id = ?
    ''', (user_id,))
    fav_rows = cursor.fetchall()
    favorite_ids = [str(row['id']) for row in fav_rows]

    cursor.execute("SELECT id, name FROM playlists WHERE user_id = ?", (user_id,))
    pl_rows = cursor.fetchall()

    playlists = []
    tracks_cache = {}

    for row in fav_rows:
        d = dict(row)
        d['dur'] = d.get('duration') or 0
        tracks_cache[str(row['id'])] = d

    for pl in pl_rows:
        cursor.execute('''
            SELECT t.* FROM tracks t
            JOIN playlist_tracks pt ON t.id = pt.track_id
            WHERE pt.playlist_id = ?
            ORDER BY pt.position ASC
        ''', (pl['id'],))
        pl_track_rows = cursor.fetchall()
        t_ids = []
        for tr in pl_track_rows:
            t_ids.append(str(tr['id']))
            td = dict(tr)
            td['dur'] = td.get('duration') or 0
            tracks_cache[str(tr['id'])] = td

        playlists.append({
            'id': pl['id'],
            'name': pl['name'],
            'trackIds': t_ids
        })

    conn.close()
    return jsonify({'favorites': favorite_ids, 'playlists': playlists, 'trackCache': tracks_cache})

@app.route('/api/sync/save', methods=['POST'])
@require_auth
def sync_save():
    data = request.json or {}
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()

    for t_id, track in data.get('trackCache', {}).items():
        upsert_track(cursor, track)

    cursor.execute("DELETE FROM favorites WHERE user_id = ?", (user_id,))
    for f_id in data.get('favorites', []):
        cursor.execute("INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?, ?)", (user_id, str(f_id)))

    cursor.execute("SELECT id FROM playlists WHERE user_id = ?", (user_id,))
    for p_id in [row['id'] for row in cursor.fetchall()]:
        cursor.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (p_id,))
    cursor.execute("DELETE FROM playlists WHERE user_id = ?", (user_id,))

    for pl in data.get('playlists', []):
        cursor.execute("INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)", (pl['id'], user_id, pl['name']))
        for pos, t_id in enumerate(pl.get('trackIds', [])):
            cursor.execute("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)", (pl['id'], str(t_id), pos))

    conn.commit()
    conn.close()
    return jsonify({'status': 'synced'})

YDL_SEARCH_OPTS = {
    'format': 'bestaudio/best',
    'noplaylist': True,
    'quiet': True,
    'extract_flat': True,
    'skip_download': True,
    'ignoreerrors': True,
    'no_warnings': True,
}

def search_youtube_fallback(query):
    search_term = f"ytsearch15:{query} song"
    tracks = []
    seen_ids = set()

    try:
        with yt_dlp.YoutubeDL(YDL_SEARCH_OPTS) as ydl:
            res = ydl.extract_info(search_term, download=False)
            if not res or 'entries' not in res:
                return []

            for entry in res['entries']:
                if not entry:
                    continue

                vid_id = entry.get('id')
                if not vid_id or vid_id in seen_ids:
                    continue

                dur = entry.get('duration') or 0
                if dur > 0 and dur < 45:
                    continue

                title = entry.get('title', 'Unknown Title')
                artist = entry.get('uploader') or entry.get('channel') or 'Unknown Artist'

                thumbnails = entry.get('thumbnails') or []
                thumbnail = thumbnails[-1].get('url') if thumbnails else f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg"

                tracks.append({
                    'id': str(vid_id),
                    'title': title,
                    'artist': artist,
                    'album': 'Single',
                    'thumbnail': thumbnail,
                    'dur': dur,
                    'duration': dur,
                    'queryTarget': f"{artist} - {title}"
                })
                seen_ids.add(vid_id)

                if len(tracks) >= 10:
                    break
    except Exception as e:
        print("YouTube fallback search error:", e)

    return tracks

@app.route('/api/search', methods=['GET'])
def search_tracks():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    tracks = []

    try:
        res = requests.get(
            "https://itunes.apple.com/search",
            params={
                "term": query,
                "media": "music",
                "entity": "song",
                "limit": 10
            },
            timeout=3
        )
        if res.status_code == 200:
            data = res.json()
            for item in data.get('results', []):
                art = item.get('artworkUrl100', '')
                high_res_art = art.replace('100x100bb', '500x500bb') if art else ''
                track_title = item.get('trackName', '')
                artist_name = item.get('artistName', '')

                tracks.append({
                    'id': str(item.get('trackId')),
                    'title': track_title,
                    'artist': artist_name,
                    'album': item.get('collectionName', 'Single'),
                    'thumbnail': high_res_art,
                    'dur': int((item.get('trackTimeMillis') or 0) / 1000),
                    'duration': int((item.get('trackTimeMillis') or 0) / 1000),
                    'queryTarget': f"{artist_name} - {track_title} audio"
                })
    except Exception as e:
        print("iTunes search error:", e)

    if len(tracks) < 3:
        yt_tracks = search_youtube_fallback(query)
        existing_ids = {t['id'] for t in tracks}
        for yt_t in yt_tracks:
            if yt_t['id'] not in existing_ids:
                tracks.append(yt_t)
                existing_ids.add(yt_t['id'])

    return jsonify(tracks[:12])

YDL_STREAM_OPTS = {
    'format': 'bestaudio/best',
    'noplaylist': True,
    'quiet': True,
}

def resolve_via_piped(query_target):
    for base in FALLBACK_APIS:
        try:
            search_res = requests.get(f"{base}/search", params={"q": query_target, "filter": "music_songs"}, timeout=4)
            if search_res.status_code == 200:
                items = search_res.json().get('items', [])
                if items:
                    v_id = items[0].get('url', '').replace('/watch?v=', '')
                    stream_res = requests.get(f"{base}/streams/{v_id}", timeout=4)
                    if stream_res.status_code == 200:
                        streams = stream_res.json().get('audioStreams', [])
                        if streams:
                            return streams[0].get('url')
        except Exception:
            continue
    return None

def resolve_direct_stream(target_query, track_id):
    now = time.time()
    if track_id in STREAM_CACHE:
        cached_url, timestamp = STREAM_CACHE[track_id]
        if now - timestamp < CACHE_TTL:
            return cached_url

    try:
        with yt_dlp.YoutubeDL(YDL_STREAM_OPTS) as ydl:
            search_info = ydl.extract_info(f"ytsearch1:{target_query}", download=False)
            if 'entries' in search_info and len(search_info['entries']) > 0:
                entry = search_info['entries'][0]
                stream_url = None

                if 'formats' in entry:
                    audio_formats = [
                        f for f in entry['formats']
                        if f.get('vcodec') == 'none' and f.get('url')
                    ]
                    if audio_formats:
                        stream_url = audio_formats[-1].get('url')

                if not stream_url:
                    stream_url = entry.get('url')

                if stream_url:
                    STREAM_CACHE[track_id] = (stream_url, now)
                    return stream_url
    except Exception as e:
        print(f"Direct resolution warning ({e}), falling back...")

    fallback_url = resolve_via_piped(target_query)
    if fallback_url:
        STREAM_CACHE[track_id] = (fallback_url, now)
        return fallback_url

    return None

@app.route('/api/stream', methods=['GET', 'OPTIONS'])
def get_stream():
    if request.method == 'OPTIONS':
        res = Response()
        res.headers['Access-Control-Allow-Origin'] = '*'
        res.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        res.headers['Access-Control-Allow-Headers'] = 'Range, Authorization, Content-Type'
        res.headers['Access-Control-Expose-Headers'] = 'Content-Range, Content-Length, Accept-Ranges'
        return res, 200

    track_id = request.args.get('id', '').strip()
    query_target = request.args.get('q', '').strip()

    if not track_id:
        return jsonify({'error': 'Track ID required'}), 400

    if not query_target or query_target == track_id:
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("SELECT title, artist FROM tracks WHERE id = ?", (track_id,))
            row = cursor.fetchone()
            conn.close()

            if row and row['title']:
                query_target = f"{row['artist']} {row['title']} official audio"
            else:
                query_target = track_id
        except Exception:
            query_target = track_id

    stream_url = resolve_direct_stream(query_target, track_id)
    if not stream_url:
        return jsonify({'error': 'Stream extraction failed'}), 500

    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }

        range_header = request.headers.get('Range', None)
        if range_header:
            headers['Range'] = range_header

        req = requests.get(stream_url, headers=headers, stream=True, timeout=12)

        def generate():
            try:
                for chunk in req.iter_content(chunk_size=1024 * 64):
                    if chunk:
                        yield chunk
            except Exception as e:
                print("Stream pipe aborted:", e)

        content_type = req.headers.get('Content-Type', 'audio/mp4')
        resp_headers = {
            'Content-Type': content_type,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
        }
        if 'Content-Range' in req.headers:
            resp_headers['Content-Range'] = req.headers['Content-Range']
        if 'Content-Length' in req.headers:
            resp_headers['Content-Length'] = req.headers['Content-Length']

        return Response(generate(), status=req.status_code, headers=resp_headers)

    except Exception as e:
        print("Proxy transport error:", str(e))
        return jsonify({'error': str(e)}), 500

@app.route('/api/prefetch', methods=['GET'])
def prefetch():
    track_id = request.args.get('id', '').strip()
    query_target = request.args.get('q', '').strip() or track_id
    if not track_id:
        return jsonify({'error': 'Track ID required'}), 400

    threading.Thread(target=lambda: resolve_direct_stream(query_target, track_id), daemon=True).start()
    return jsonify({'status': 'prefetching'})

if __name__ == '__main__':
    # debug=False and use_reloader=False prevents Flask from ever rebooting
    app.run(port=5000, debug=False, use_reloader=False)