import os
import time
import threading
import sqlite3
import requests
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import yt_dlp

app = Flask(__name__)
CORS(app)

DB_NAME = "music.db"

# In-Memory Stream Cache
STREAM_CACHE = {}
CACHE_TTL = 3600 * 4  # 4 hours

FALLBACK_APIS = [
    "https://pipedapi.kavin.rocks",
    "https://api.piped.privacydev.net",
    "https://piped-api.lunar.icu"
]

def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
    ''')
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

def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

def upsert_track(cursor, track):
    if not track or 'id' not in track:
        return
    cursor.execute('''
        INSERT OR REPLACE INTO tracks (id, title, artist, thumbnail, duration)
        VALUES (?, ?, ?, ?, ?)
    ''', (track['id'], track.get('title'), track.get('artist'), track.get('thumbnail'), track.get('dur', 0)))

# ----------------- Auth Endpoints -----------------
@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json or {}
    username = data.get('username', '').strip().lower()
    password = data.get('password', '').strip()

    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400

    hashed_pw = generate_password_hash(password)
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, hashed_pw))
        conn.commit()
        user_id = cursor.lastrowid
        return jsonify({'message': 'User registered', 'user': {'id': user_id, 'username': username}})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Username already taken'}), 409
    finally:
        conn.close()

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json or {}
    username = data.get('username', '').strip().lower()
    password = data.get('password', '').strip()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()
    conn.close()

    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify({'error': 'Invalid credentials'}), 401

    return jsonify({'message': 'Login successful', 'user': {'id': user['id'], 'username': user['username']}})

# ----------------- Sync Endpoints -----------------
@app.route('/api/sync/load', methods=['GET'])
def sync_load():
    user_id = request.args.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT t.* FROM tracks t
        JOIN favorites f ON t.id = f.track_id
        WHERE f.user_id = ?
    ''', (user_id,))
    fav_rows = cursor.fetchall()
    favorite_ids = [row['id'] for row in fav_rows]

    cursor.execute("SELECT id, name FROM playlists WHERE user_id = ?", (user_id,))
    pl_rows = cursor.fetchall()

    playlists = []
    tracks_cache = {row['id']: dict(row) for row in fav_rows}

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
            t_ids.append(tr['id'])
            tracks_cache[tr['id']] = dict(tr)

        playlists.append({
            'id': pl['id'],
            'name': pl['name'],
            'trackIds': t_ids
        })

    conn.close()
    return jsonify({'favorites': favorite_ids, 'playlists': playlists, 'trackCache': tracks_cache})

@app.route('/api/sync/save', methods=['POST'])
def sync_save():
    data = request.json or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'error': 'User ID required'}), 400

    conn = get_db()
    cursor = conn.cursor()

    for t_id, track in data.get('trackCache', {}).items():
        upsert_track(cursor, track)

    cursor.execute("DELETE FROM favorites WHERE user_id = ?", (user_id,))
    for f_id in data.get('favorites', []):
        cursor.execute("INSERT OR IGNORE INTO favorites (user_id, track_id) VALUES (?, ?)", (user_id, f_id))

    cursor.execute("SELECT id FROM playlists WHERE user_id = ?", (user_id,))
    for p_id in [row['id'] for row in cursor.fetchall()]:
        cursor.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?", (p_id,))
    cursor.execute("DELETE FROM playlists WHERE user_id = ?", (user_id,))

    for pl in data.get('playlists', []):
        cursor.execute("INSERT INTO playlists (id, user_id, name) VALUES (?, ?, ?)", (pl['id'], user_id, pl['name']))
        for pos, t_id in enumerate(pl.get('trackIds', [])):
            cursor.execute("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)", (pl['id'], t_id, pos))

    conn.commit()
    conn.close()
    return jsonify({'status': 'synced'})

# ----------------- Lightning Fast Music Search (iTunes Engine) -----------------
@app.route('/api/search', methods=['GET'])
def search_tracks():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])

    try:
        # iTunes API returns purely licensed music, ~300ms response, zero rate-limit blocks
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
            tracks = []
            for item in data.get('results', []):
                # Upgrade artwork to crisp 500x500 high-res
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
                    # Target query passed for instant resolver
                    'queryTarget': f"{artist_name} - {track_title} audio"
                })
            return jsonify(tracks)
    except Exception as e:
        print("Fast search fallback error:", e)

    return jsonify([])

# ----------------- Stream Extractor & Proxy -----------------
YDL_STREAM_OPTS = {
    'format': 'bestaudio[ext=m4a]/bestaudio/best',
    'noplaylist': True,
    'quiet': True,
    'extractor_args': {
        'youtube': {
            'player_client': ['android', 'web_creator']
        }
    }
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

    # Attempt 1: yt-dlp search with Android client
    try:
        with yt_dlp.YoutubeDL(YDL_STREAM_OPTS) as ydl:
            # Look up top result for exact song target
            search_info = ydl.extract_info(f"ytsearch1:{target_query}", download=False)
            if 'entries' in search_info and len(search_info['entries']) > 0:
                entry = search_info['entries'][0]
                stream_url = entry.get('url')
                if not stream_url and 'formats' in entry:
                    af = [f for f in entry['formats'] if f.get('vcodec') == 'none' and f.get('url')]
                    stream_url = af[-1].get('url') if af else entry['formats'][-1].get('url')

                if stream_url:
                    STREAM_CACHE[track_id] = (stream_url, now)
                    return stream_url
    except Exception as e:
        print(f"Direct resolution warning ({e}), falling back...")

    # Attempt 2: Piped API
    fallback_url = resolve_via_piped(target_query)
    if fallback_url:
        STREAM_CACHE[track_id] = (fallback_url, now)
        return fallback_url

    return None

@app.route('/api/stream', methods=['GET'])
def get_stream():
    track_id = request.args.get('id', '').strip()
    query_target = request.args.get('q', '').strip() or track_id

    if not track_id:
        return jsonify({'error': 'Track ID required'}), 400

    try:
        stream_url = resolve_direct_stream(query_target, track_id)
        if not stream_url:
            return jsonify({'error': 'Stream extraction failed'}), 500

        headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Referer': 'https://www.youtube.com/'
        }

        range_header = request.headers.get('Range', None)
        if range_header:
            headers['Range'] = range_header

        req = requests.get(stream_url, headers=headers, stream=True, timeout=12)

        def generate():
            for chunk in req.iter_content(chunk_size=1024 * 64):
                if chunk:
                    yield chunk

        resp_headers = {
            'Content-Type': req.headers.get('Content-Type', 'audio/mp4'),
            'Accept-Ranges': 'bytes'
        }
        if 'Content-Range' in req.headers:
            resp_headers['Content-Range'] = req.headers['Content-Range']
        if 'Content-Length' in req.headers:
            resp_headers['Content-Length'] = req.headers['Content-Length']

        return Response(generate(), status=req.status_code, headers=resp_headers)

    except Exception as e:
        print("Proxy error:", str(e))
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
    app.run(port=5000, debug=True)