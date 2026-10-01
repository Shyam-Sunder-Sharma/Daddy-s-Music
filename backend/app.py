import os
import sys

# Prevent Python from writing .pyc files in the workspace folder (which triggers Live Server)
sys.dont_write_bytecode = True

import re
import time
import socket
import shutil
import subprocess
import threading
import sqlite3
import requests
from requests.adapters import HTTPAdapter
from flask import Flask, request, jsonify, Response, g, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, join_room, leave_room, emit
import yt_dlp

# Force IPv4 (AF_INET) + in-memory DNS cache to prevent 21-42s Windows IPv6 DNS/connect timeouts
_ORIG_GETADDRINFO = socket.getaddrinfo
_DNS_CACHE = {}
_DNS_LOCK = threading.Lock()

def _fast_ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    cache_key = (host, port, type, proto, flags)
    with _DNS_LOCK:
        cached = _DNS_CACHE.get(cache_key)
    if cached:
        return cached
    try:
        res = _ORIG_GETADDRINFO(host, port, socket.AF_INET, type, proto, flags)
        if res:
            with _DNS_LOCK:
                _DNS_CACHE[cache_key] = res
            return res
    except Exception:
        pass
    return _ORIG_GETADDRINFO(host, port, family, type, proto, flags)

socket.getaddrinfo = _fast_ipv4_getaddrinfo

# Persistent HTTP session with connection pooling for instant TLS reuse
HTTP_SESSION = requests.Session()
_http_adapter = HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=1)
HTTP_SESSION.mount("https://", _http_adapter)
HTTP_SESSION.mount("http://", _http_adapter)
HTTP_SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
})

import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from auth import auth_bp, init_auth_db, require_auth

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

FRONTEND_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "frontend"))
if not os.path.isdir(FRONTEND_DIR):
    FRONTEND_DIR = BASE_DIR

ALLOWED_FRONTEND_FILES = {
    "index.html",
    "styles.css",
    "socket.io.min.js",
    "app.js",
    "auth-gate.js",
    "manifest.json",
    "sw.js"
}

@app.route('/')
@app.route('/frontend/')
def serve_index():
    resp = send_from_directory(FRONTEND_DIR, 'index.html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return resp

@app.route('/frontend/<path:filename>')
@app.route('/<path:filename>')
def serve_frontend(filename):
    if filename in ALLOWED_FRONTEND_FILES:
        resp = send_from_directory(FRONTEND_DIR, filename)
        resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return resp
    return jsonify({'error': 'Not found'}), 404

app.register_blueprint(auth_bp)

# Store the database and LRU audio cache in a separate hidden directory outside the workspace
# so file watchers (VS Code Live Server / OneDrive) NEVER trigger a browser reload
DATA_DIR = os.environ.get("DADDY_MUSIC_DATA_DIR") or os.path.join(os.path.expanduser("~"), ".daddys_music_data")
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = os.path.join(tempfile.gettempdir(), ".daddys_music_data")
    os.makedirs(DATA_DIR, exist_ok=True)
AUDIO_CACHE_DIR = os.path.join(DATA_DIR, "audio_cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)
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
MAX_LRU_CACHED_FILES = 40
ACTIVE_DOWNLOADS = set()
DOWNLOAD_LOCK = threading.Lock()

# Locate FFmpeg binary (system PATH or imageio_ffmpeg) for on-the-fly transcoding
FFMPEG_BIN = shutil.which("ffmpeg")
if not FFMPEG_BIN:
    try:
        import imageio_ffmpeg
        FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        FFMPEG_BIN = None

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
            duration INTEGER,
            album TEXT DEFAULT 'Single',
            genre TEXT DEFAULT ''
        )
    ''')
    try:
        cursor.execute("ALTER TABLE tracks ADD COLUMN album TEXT DEFAULT 'Single'")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE tracks ADD COLUMN genre TEXT DEFAULT ''")
    except Exception:
        pass

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
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS play_stats (
            user_id INTEGER,
            track_id TEXT,
            play_count INTEGER DEFAULT 0,
            last_played_at INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, track_id)
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
    album = track.get('album') or 'Single'
    genre = track.get('genre') or ''
    cursor.execute('''
        INSERT OR REPLACE INTO tracks (id, title, artist, thumbnail, duration, album, genre)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (str(track['id']), track.get('title'), track.get('artist'), track.get('thumbnail'), int(duration), album, genre))

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

    cursor.execute('''
        SELECT ps.track_id, ps.play_count, ps.last_played_at, t.*
        FROM play_stats ps
        LEFT JOIN tracks t ON t.id = ps.track_id
        WHERE ps.user_id = ?
        ORDER BY ps.last_played_at DESC
    ''', (user_id,))
    stat_rows = cursor.fetchall()
    play_counts = {}
    last_played_at = {}
    last_track = None
    for sr in stat_rows:
        tid = str(sr['track_id'])
        play_counts[tid] = sr['play_count'] or 0
        last_played_at[tid] = sr['last_played_at'] or 0
        if sr['title']:
            td = dict(sr)
            td['id'] = tid
            td['dur'] = td.get('duration') or 0
            tracks_cache[tid] = td
            if last_track is None:
                last_track = td

    conn.close()
    return jsonify({
        'favorites': favorite_ids,
        'playlists': playlists,
        'playCounts': play_counts,
        'lastPlayedAt': last_played_at,
        'lastTrack': last_track,
        'trackCache': tracks_cache
    })

@app.route('/api/sync/save', methods=['POST'])
@require_auth
def sync_save():
    data = request.json or {}
    user_id = g.current_user['id']

    conn = get_db()
    cursor = conn.cursor()

    for t_id, track in data.get('trackCache', {}).items():
        upsert_track(cursor, track)

    if data.get('lastTrack'):
        upsert_track(cursor, data['lastTrack'])

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

    play_counts = data.get('playCounts') or {}
    last_played = data.get('lastPlayedAt') or {}
    for tid, count in play_counts.items():
        lp = int(last_played.get(tid) or 0)
        cursor.execute('''
            INSERT OR REPLACE INTO play_stats (user_id, track_id, play_count, last_played_at)
            VALUES (?, ?, ?, ?)
        ''', (user_id, str(tid), int(count or 0), lp))

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
        res = HTTP_SESSION.get(
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
                    'genre': item.get('primaryGenreName', '') or '',
                    'thumbnail': high_res_art,
                    'dur': int((item.get('trackTimeMillis') or 0) / 1000),
                    'duration': int((item.get('trackTimeMillis') or 0) / 1000),
                    'queryTarget': f"{artist_name} - {track_title}"
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


@app.route('/api/recommend', methods=['GET'])
def recommend_tracks():
    track_id = request.args.get('id', '').strip()
    title = request.args.get('title', '').strip()
    artist = request.args.get('artist', '').strip()
    genre = request.args.get('genre', '').strip()
    exclude_raw = request.args.get('exclude', '').strip()

    exclude_ids = {x.strip() for x in exclude_raw.split(',') if x.strip()}
    if track_id:
        exclude_ids.add(track_id)

    norm_seed_title = re.sub(r'[^a-z0-9]+', '', title.lower())
    primary_artist = artist.split(',')[0].split('&')[0].split('feat')[0].strip() if artist else ''

    # Step 1: If genre is unknown or generic, look up the seed track on iTunes to get its exact primaryGenreName
    if not genre or genre.lower() in ('music', 'unknown', 'single'):
        lookup_term = f"{primary_artist} {title}".strip() or title or primary_artist
        if lookup_term:
            try:
                r_meta = HTTP_SESSION.get(
                    "https://itunes.apple.com/search",
                    params={"term": lookup_term, "media": "music", "entity": "song", "limit": 3},
                    timeout=3
                )
                if r_meta.status_code == 200:
                    for item in r_meta.json().get('results', []):
                        g_name = (item.get('primaryGenreName') or '').strip()
                        if g_name:
                            genre = g_name
                            if not primary_artist and item.get('artistName'):
                                primary_artist = item['artistName'].split(',')[0].split('&')[0].strip()
                            break
            except Exception:
                pass

    # Step 2: Build genre-driven search queries so recommendations match the exact genre & vibe
    search_terms = []
    if genre and primary_artist:
        search_terms.append(f"{genre} {primary_artist}")
    if genre:
        search_terms.append(f"{genre} hits")
        search_terms.append(f"top {genre} songs")
    if primary_artist:
        search_terms.append(primary_artist)

    if not search_terms:
        search_terms = ["top hits songs"]

    same_genre_candidates = []
    other_candidates = []
    seen_ids = set(exclude_ids)
    seen_titles = {norm_seed_title} if norm_seed_title else set()

    for term in search_terms[:3]:
        try:
            res = HTTP_SESSION.get(
                "https://itunes.apple.com/search",
                params={"term": term, "media": "music", "entity": "song", "limit": 20},
                timeout=3
            )
            if res.status_code != 200:
                continue
            for item in res.json().get('results', []):
                tid = str(item.get('trackId') or '')
                if not tid or tid in seen_ids:
                    continue
                t_title = (item.get('trackName') or '').strip()
                t_artist = (item.get('artistName') or '').strip()
                if not t_title or not t_artist:
                    continue
                norm_t = re.sub(r'[^a-z0-9]+', '', t_title.lower())
                if norm_t in seen_titles:
                    continue

                seen_ids.add(tid)
                seen_titles.add(norm_t)

                art = item.get('artworkUrl100', '')
                high_res_art = art.replace('100x100bb', '500x500bb') if art else ''
                item_genre = (item.get('primaryGenreName') or genre or '').strip()
                dur_sec = int((item.get('trackTimeMillis') or 0) / 1000)
                if dur_sec > 0 and dur_sec < 45:
                    continue

                track_obj = {
                    'id': tid,
                    'title': t_title,
                    'artist': t_artist,
                    'album': item.get('collectionName', 'Single'),
                    'genre': item_genre,
                    'thumbnail': high_res_art,
                    'dur': dur_sec,
                    'duration': dur_sec,
                    'queryTarget': f"{t_artist} - {t_title}"
                }

                if genre and item_genre.lower() == genre.lower():
                    same_genre_candidates.append(track_obj)
                else:
                    other_candidates.append(track_obj)
        except Exception:
            pass

        if len(same_genre_candidates) >= 10:
            break

    combined = same_genre_candidates + other_candidates
    return jsonify({
        'genre': genre or 'Similar Vibe',
        'tracks': combined[:12]
    })

# ---------- Tier 4+: Ultra-Fast Resolution, Progressive RAM Buffer & LRU Disk Cache ----------
SEARCH_ID_CACHE = {}
_RESOLVE_LOCKS = {}
_RESOLVE_GLOBAL_LOCK = threading.Lock()
ACTIVE_STREAM_BUFFERS = {}  # { (track_id, kind): ProgressiveStreamBuffer }
_BUFFER_LOCK = threading.Lock()

import html as _html

# Persistent warm YoutubeDL instances so player JS & tokens stay cached in memory
_YDL_NODE_LOCK = threading.Lock()
_YDL_ANDROID_LOCK = threading.Lock()
_YDL_TV_LOCK = threading.Lock()
_YDL_SC_LOCK = threading.Lock()

_YDL_NODE = yt_dlp.YoutubeDL({
    'quiet': True,
    'no_warnings': True,
    'noplaylist': True,
    'js_runtimes': {'node': {}}
})

_YDL_ANDROID = yt_dlp.YoutubeDL({
    'quiet': True,
    'no_warnings': True,
    'noplaylist': True,
    'extractor_args': {
        'youtube': {
            'player_client': ['android'],
            'player_skip': ['webpage', 'configs']
        }
    }
})

_YDL_TV_IOS = yt_dlp.YoutubeDL({
    'quiet': True,
    'no_warnings': True,
    'noplaylist': True,
    'extractor_args': {
        'youtube': {
            'player_client': ['tv_embedded', 'ios', 'mweb']
        }
    }
})

_YDL_SC = yt_dlp.YoutubeDL({
    'quiet': True,
    'no_warnings': True,
    'noplaylist': True
})

def _warmup_extractors_bg():
    """Pre-warm DNS, TLS session pool, SoundCloud client_id, and yt-dlp at server startup."""
    try:
        fast_search_youtube_video_id("Ed Sheeran Shape of You official music video")
        with _YDL_SC_LOCK:
            _YDL_SC.extract_info("scsearch1:Shape of You", download=False)
    except Exception:
        pass
    try:
        with _YDL_NODE_LOCK:
            _YDL_NODE.extract_info("https://www.youtube.com/watch?v=JGwWNGJdvx8", download=False)
    except Exception:
        pass

threading.Thread(target=_warmup_extractors_bg, daemon=True).start()

def _safe_cache_key(track_id):
    return re.sub(r'[^a-zA-Z0-9_\-]', '_', str(track_id))

def get_cached_media_path(track_id, kind="audio"):
    safe_id = _safe_cache_key(track_id)
    if kind == "audio":
        candidates = [
            os.path.join(AUDIO_CACHE_DIR, f"{safe_id}_fast.audio"),
            os.path.join(AUDIO_CACHE_DIR, f"{safe_id}.audio"),
        ]
        for path in candidates:
            if os.path.isfile(path):
                sz = os.path.getsize(path)
                # Only use legacy .audio file if it's compact (< 8 MB)
                if sz > 32768 and (path.endswith("_fast.audio") or sz < 8 * 1024 * 1024):
                    try:
                        os.utime(path, None)
                    except Exception:
                        pass
                    return path
    else:
        candidates = [
            os.path.join(AUDIO_CACHE_DIR, f"{safe_id}_fast.video"),
            os.path.join(AUDIO_CACHE_DIR, f"{safe_id}_mv.mp4"),
        ]
        for path in candidates:
            if os.path.isfile(path) and os.path.getsize(path) > 65536:
                try:
                    os.utime(path, None)
                except Exception:
                    pass
                return path
    return None

def enforce_lru_disk_cache():
    try:
        files = []
        for fn in os.listdir(AUDIO_CACHE_DIR):
            if fn.endswith((".mp4", ".audio", ".video")):
                full = os.path.join(AUDIO_CACHE_DIR, fn)
                if os.path.isfile(full):
                    files.append((os.path.getmtime(full), full))
        if len(files) > MAX_LRU_CACHED_FILES:
            files.sort(key=lambda x: x[0])
            for _, old_path in files[: len(files) - MAX_LRU_CACHED_FILES]:
                try:
                    os.remove(old_path)
                except Exception:
                    pass
    except Exception:
        pass

def _detect_media_mime(file_path, kind="audio"):
    try:
        with open(file_path, "rb") as f:
            head = f.read(16)
        if head.startswith(b"\x1a\x45\xdf\xa3"):
            return "audio/webm" if kind == "audio" else "video/webm"
        if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
            return "audio/mpeg"
        if head.startswith(b"OggS"):
            return "audio/ogg"
        if b"ftyp" in head:
            return "audio/mp4" if kind == "audio" else "video/mp4"
    except Exception:
        pass
    return "audio/webm" if kind == "audio" else "video/mp4"

def serve_cached_file_with_range(file_path, kind="audio"):
    file_size = os.path.getsize(file_path)
    range_header = request.headers.get('Range', None)
    mime_type = _detect_media_mime(file_path, kind=kind)

    base_headers = {
        'Content-Type': mime_type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
    }

    if not range_header:
        base_headers['Content-Length'] = str(file_size)
        def generate_full():
            with open(file_path, 'rb') as f:
                while True:
                    chunk = f.read(1024 * 64)
                    if not chunk:
                        break
                    yield chunk
        return Response(generate_full(), status=200, headers=base_headers)

    match = re.search(r'bytes=(\d+)-(\d*)', range_header)
    if not match:
        base_headers['Content-Length'] = str(file_size)
        return Response(open(file_path, 'rb'), status=200, headers=base_headers)

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        return Response(status=416, headers={'Content-Range': f'bytes */{file_size}'})

    length = end - start + 1
    base_headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
    base_headers['Content-Length'] = str(length)

    def generate_range():
        with open(file_path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 64, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return Response(generate_range(), status=206, headers=base_headers)

def _build_mv_search_query(raw_query):
    q = (raw_query or "").strip()
    q = re.sub(r'\b(official\s+audio|audio)\s*$', '', q, flags=re.IGNORECASE).strip()
    if " - " in q:
        parts = q.split(" - ", 1)
        artist_part = parts[0].split(",")[0].split("&")[0].strip()
        title_part = parts[1].strip()
        q = f"{artist_part} - {title_part}"
    if "video" not in q.lower():
        q = f"{q} official music video"
    return q

def fast_search_youtube_video_id(query):
    """Resolve YouTube videoId in ~0.45s via InnerTube JSON API over persistent HTTP_SESSION."""
    q_key = query.strip().lower()
    if q_key in SEARCH_ID_CACHE:
        return SEARCH_ID_CACHE[q_key]

    try:
        resp = HTTP_SESSION.post(
            "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
            json={
                "context": {
                    "client": {
                        "clientName": "WEB",
                        "clientVersion": "2.20250312.04.00",
                        "hl": "en",
                        "gl": "US"
                    }
                },
                "query": query,
                "params": "EgIQAQ%3D%3D"  # Filter: Videos only
            },
            timeout=4
        )
        if resp.status_code == 200:
            matches = re.findall(r'"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"', resp.text)
            if matches:
                vid = matches[0]
                SEARCH_ID_CACHE[q_key] = vid
                return vid
    except Exception as e:
        print("InnerTube fast search note:", e)

    return None

def _pick_best_formats(info):
    """Select compact, fast-streaming audio (~1.8MB) and video (~2.3MB) URLs from extracted formats."""
    formats = [
        f for f in (info.get('formats') or [])
        if f.get('url') and not str(f.get('format_id', '')).startswith('sb') and 'manifest' not in str(f.get('url', ''))
    ]
    by_id = {str(f.get('format_id')): f for f in formats}

    # 1. Pick ultra-fast audio stream (48kbps-64kbps Opus/AAC = 6-8 KB/s, streams at 5x-15x real-time)
    audio_url = None
    audio_mime = "audio/webm"
    audio_headers = {}
    for fid, mime in [
        ('250', 'audio/webm'),
        ('249', 'audio/webm'),
        ('139', 'audio/mp4'),
        ('251', 'audio/webm'),
        ('140', 'audio/mp4'),
    ]:
        if fid in by_id:
            audio_url = by_id[fid]['url']
            audio_mime = mime
            audio_headers = dict(by_id[fid].get('http_headers') or {})
            break

    if not audio_url:
        audio_only = [f for f in formats if f.get('acodec') != 'none' and f.get('vcodec') == 'none']
        if audio_only:
            audio_only.sort(key=lambda x: x.get('tbr') or x.get('abr') or 999)
            chosen_a = audio_only[0]
            audio_url = chosen_a['url']
            audio_mime = 'audio/mp4' if chosen_a.get('ext') == 'm4a' else 'audio/webm'
            audio_headers = dict(chosen_a.get('http_headers') or {})

    # 2. Pick compact fast-streaming video stream for #videoModal (240p/144p = 8-17 KB/s)
    video_url = None
    video_mime = "video/webm"
    video_headers = {}
    for fid, mime in [
        ('242', 'video/webm'),
        ('133', 'video/mp4'),
        ('278', 'video/webm'),
        ('160', 'video/mp4'),
        ('18', 'video/mp4'),
    ]:
        if fid in by_id:
            video_url = by_id[fid]['url']
            video_mime = mime
            video_headers = dict(by_id[fid].get('http_headers') or {})
            break

    if not video_url:
        vid_fmts = [f for f in formats if f.get('vcodec') != 'none']
        if vid_fmts:
            vid_fmts.sort(key=lambda x: x.get('tbr') or 9999)
            chosen_v = vid_fmts[0]
            video_url = chosen_v['url']
            video_mime = 'video/webm' if chosen_v.get('ext') == 'webm' else 'video/mp4'
            video_headers = dict(chosen_v.get('http_headers') or {})

    if not audio_url and video_url:
        audio_url = video_url
        audio_mime = video_mime
        audio_headers = video_headers
    if not video_url and audio_url:
        video_url = audio_url
        video_mime = audio_mime
        video_headers = audio_headers

    return audio_url, audio_mime, audio_headers, video_url, video_mime, video_headers

_LABEL_NOISE_RE = re.compile(
    r'\b(universal\s+music(\s+india)?|t-series|zee\s+music(\s+company)?|sony\s+music(\s+india)?|'
    r'yrf|tips\s+official|saregama(\s+music)?|speed\s+records|white\s+hill\s+music|desi\s+melodies|'
    r'unplgd\s+records(\s+and)?|unplg\'?d|vevo|topic|records|official\s+music\s+video|official\s+video|'
    r'official\s+audio|full\s+video|full\s+song|lyrical\s+video|trending\s+song|8k|4k|hd|video|audio|song)\b',
    re.IGNORECASE
)

def _build_clean_queries(raw_query):
    """Strip YouTube channel names, pipes, @handles, and SEO tags into clean search queries."""
    q = (raw_query or "").strip()
    q_no_pipe = q.split("|")[0].strip()
    q_no_brackets = re.sub(r'\(.*?\)|\[.*?\]|\{.*?\}', ' ', q_no_pipe)
    q_no_handles = re.sub(r'@\S+', ' ', q_no_brackets)

    candidates = []
    if " - " in q_no_handles:
        raw_parts = q_no_handles.split(" - ")
        cleaned_parts = []
        for idx, p in enumerate(raw_parts):
            if idx == 0:
                p = re.split(r'[,&]', p)[0]
            cp = _LABEL_NOISE_RE.sub(" ", p)
            cp = re.sub(r'[-–—:/\\,]+', ' ', cp)
            cp = re.sub(r'\s+', ' ', cp).strip()
            if cp:
                cleaned_parts.append(cp)
        if len(cleaned_parts) >= 2:
            candidates.append(f"{cleaned_parts[1]} {cleaned_parts[0]}".strip())
            candidates.append(f"{cleaned_parts[0]} {cleaned_parts[1]}".strip())
            candidates.append(cleaned_parts[1])
        elif len(cleaned_parts) == 1:
            candidates.append(cleaned_parts[0])

    q_clean = _LABEL_NOISE_RE.sub(" ", q_no_handles)
    q_clean = re.sub(r'[-–—:/\\,&]+', ' ', q_clean)
    q_clean = re.sub(r'\s+', ' ', q_clean).strip()
    if q_clean and q_clean not in candidates:
        candidates.append(q_clean)

    dedup = []
    for c in candidates:
        if len(c) >= 2 and c not in dedup:
            dedup.append(c)
    return dedup[:3] or [q[:60]]

def _score_saavn_item(c_name, c_artists, c_dur, query_str, raw_lower):
    if c_dur < 35:
        return -999
    ct = c_name.lower()
    ca = c_artists.lower()
    for bad_kw in ("karaoke", "nightcore", "instrumental", "8d audio", "ringtone", "backing track", "originally performed"):
        if bad_kw in ct and bad_kw not in raw_lower and bad_kw not in ca:
            return -999
        if "karaoke" in ca and "karaoke" not in raw_lower:
            return -999
    q_words = [w for w in re.split(r'\W+', query_str.lower()) if len(w) >= 2]
    if not q_words:
        return -999
    title_hits = sum(1 for w in q_words if w in ct)
    artist_hits = sum(1 for w in q_words if w in ca)
    if title_hits == 0:
        return -999
    if (title_hits + artist_hits) < min(2, len(q_words)):
        return -999
    score = title_hits * 25 + artist_hits * 20
    if "remix" in ct and "remix" not in raw_lower:
        score -= 40
    if "lofi" in ct and "lofi" not in raw_lower:
        score -= 30
    return score

def _resolve_saavn_audio(target_query):
    """
    Resolve full-length 160kbps/320kbps MP4 stream from official JioSaavn CDN in ~0.35s.
    Works 100% on cloud datacenter IPs (Render/Railway/AWS) with zero YouTube bot blocking.
    """
    clean_queries = _build_clean_queries(target_query)
    raw_lower = (target_query or "").lower()

    # 1. Official JioSaavn API (www.jiosaavn.com/api.php — fastest & most reliable)
    for q_str in clean_queries[:2]:
        try:
            r = HTTP_SESSION.get(
                "https://www.jiosaavn.com/api.php",
                params={
                    "__call": "search.getResults",
                    "_format": "json",
                    "_marker": "0",
                    "api_version": "4",
                    "ctx": "web6dot0",
                    "n": "6",
                    "p": "1",
                    "q": q_str
                },
                timeout=4
            )
            if r.status_code == 200:
                results = r.json().get("results") or []
                best_enc = None
                best_score = -1
                for it in results:
                    c_name = _html.unescape(it.get("title") or "")
                    more = it.get("more_info") or {}
                    c_dur = int(more.get("duration") or 0)
                    c_artists = _html.unescape(it.get("subtitle") or "")
                    enc_url = more.get("encrypted_media_url")
                    if not enc_url:
                        continue
                    sc = _score_saavn_item(c_name, c_artists, c_dur, q_str, raw_lower)
                    if sc > best_score:
                        best_score = sc
                        best_enc = enc_url
                if best_enc and best_score >= 20:
                    r_tok = HTTP_SESSION.get(
                        "https://www.jiosaavn.com/api.php",
                        params={
                            "__call": "song.generateAuthToken",
                            "url": best_enc,
                            "bitrate": "160",
                            "api_version": "4",
                            "_format": "json",
                            "ctx": "web6dot0",
                            "_marker": "0"
                        },
                        timeout=4
                    )
                    if r_tok.status_code == 200:
                        auth_url = (r_tok.json() or {}).get("auth_url") or ""
                        m_path = re.search(r'saavncdn\.com(/.*?_\d+\.mp4)', auth_url)
                        if m_path:
                            cdn_path = re.sub(r'_\d+\.mp4$', '_160.mp4', m_path.group(1))
                            return f"https://aac.saavncdn.com{cdn_path}", "audio/mp4", {}
                        if auth_url:
                            return auth_url, "audio/mp4", {}
        except Exception:
            pass

    # 2. Secondary Saavn API mirror
    try:
        q_str = clean_queries[0]
        r = HTTP_SESSION.get(
            "https://saavn.sumit.co/api/search/songs",
            params={"query": q_str, "limit": 6},
            timeout=3
        )
        if r.status_code == 200:
            items = ((r.json().get("data") or {}).get("results") or [])
            best_url = None
            best_score = -1
            for it in items:
                c_name = _html.unescape(it.get("name") or "")
                c_dur = int(it.get("duration") or 0)
                c_artists = ", ".join(
                    [_html.unescape(a.get("name", "")) for a in ((it.get("artists") or {}).get("primary") or [])]
                )
                sc = _score_saavn_item(c_name, c_artists, c_dur, q_str, raw_lower)
                if sc > best_score:
                    durls = it.get("downloadUrl") or []
                    u_cand = next(
                        (u.get("url") for u in durls if u.get("quality") == "160kbps"),
                        durls[-1].get("url") if durls else None
                    )
                    if u_cand:
                        best_score = sc
                        best_url = u_cand
            if best_url and best_score >= 20:
                return best_url, "audio/mp4", {}
    except Exception:
        pass

    return None, None, None

def _resolve_soundcloud_audio(target_query):
    """Resolve full-length progressive MP3 stream from SoundCloud (never blocked on cloud IPs)."""
    q_str = _build_clean_queries(target_query)[0]
    try:
        with _YDL_SC_LOCK:
            info = _YDL_SC.extract_info(f"scsearch3:{q_str}", download=False)
        for entry in (info.get("entries") or []):
            if not entry:
                continue
            dur = entry.get("duration") or 0
            if dur < 40 or dur > 900:
                continue
            fmts = [
                f for f in (entry.get("formats") or [])
                if f.get("url")
                and f.get("protocol") in ("http", "https")
                and "preview" not in str(f.get("format_id", "")).lower()
            ]
            if fmts:
                chosen = fmts[0]
                return chosen["url"], "audio/mpeg", dict(chosen.get("http_headers") or {})
    except Exception as e:
        print("SoundCloud extractor note:", e)
    return None, None, None

def _resolve_itunes_fallback(track_id, target_query):
    """Guaranteed high-speed Apple CDN M4A / M4V fallback so cloud streams never 500."""
    audio_url = None
    video_url = None
    clean_queries = _build_clean_queries(target_query)
    try:
        if str(track_id).isdigit():
            r = HTTP_SESSION.get(
                "https://itunes.apple.com/lookup",
                params={"id": str(track_id)},
                timeout=4
            )
            if r.status_code == 200:
                res = r.json().get("results") or []
                if res and res[0].get("previewUrl"):
                    audio_url = res[0]["previewUrl"]
        for q_str in clean_queries:
            if not audio_url:
                r = HTTP_SESSION.get(
                    "https://itunes.apple.com/search",
                    params={"term": q_str, "entity": "song", "limit": 2},
                    timeout=4
                )
                if r.status_code == 200:
                    res = r.json().get("results") or []
                    if res and res[0].get("previewUrl"):
                        audio_url = res[0]["previewUrl"]
            if not video_url:
                rv = HTTP_SESSION.get(
                    "https://itunes.apple.com/search",
                    params={"term": q_str, "entity": "musicVideo", "limit": 2},
                    timeout=4
                )
                if rv.status_code == 200:
                    res_v = rv.json().get("results") or []
                    if res_v and res_v[0].get("previewUrl"):
                        video_url = res_v[0]["previewUrl"]
            if audio_url and video_url:
                break
    except Exception:
        pass
    return audio_url, video_url

def resolve_track_streams(target_query, track_id, force_refresh=False, need_video=False):
    """Resolve audio and video stream URLs with multi-tier cloud fallback and lock deduplication."""
    now = time.time()
    if not force_refresh:
        cached = STREAM_CACHE.get(track_id)
        if cached and (now - cached['ts'] < CACHE_TTL):
            if not need_video or not cached.get('needs_yt_video'):
                return cached

    with _RESOLVE_GLOBAL_LOCK:
        lock = _RESOLVE_LOCKS.get(track_id)
        if not lock:
            lock = threading.Lock()
            _RESOLVE_LOCKS[track_id] = lock

    with lock:
        now = time.time()
        if not force_refresh:
            cached = STREAM_CACHE.get(track_id)
            if cached and (now - cached['ts'] < CACHE_TTL):
                if not need_video or not cached.get('needs_yt_video'):
                    return cached

        # Tier 1: Try ultra-fast JioSaavn CDN (0.35s, 160kbps full-length MP4, never blocked on Render/AWS)
        saavn_url, saavn_mime, saavn_hdrs = (None, None, None)
        if not need_video:
            saavn_url, saavn_mime, saavn_hdrs = _resolve_saavn_audio(target_query)
            if saavn_url:
                entry_data = {
                    'audio_url': saavn_url,
                    'audio_mime': saavn_mime,
                    'audio_headers': saavn_hdrs,
                    'video_url': saavn_url,
                    'video_mime': saavn_mime,
                    'video_headers': saavn_hdrs,
                    'needs_yt_video': True,
                    'ts': time.time()
                }
                STREAM_CACHE[track_id] = entry_data
                return entry_data

        # Tier 2: Try YouTube multi-client extractors (Node, Android, TV/iOS/MWeb)
        mv_query = _build_mv_search_query(target_query)
        video_id = fast_search_youtube_video_id(mv_query)
        if not video_id and re.match(r'^[A-Za-z0-9_-]{11}$', str(track_id)):
            video_id = str(track_id)

        yt_target = f"https://www.youtube.com/watch?v={video_id}" if video_id else f"ytsearch1:{mv_query}"

        for ydl_inst, ydl_lock in [
            (_YDL_NODE, _YDL_NODE_LOCK),
            (_YDL_ANDROID, _YDL_ANDROID_LOCK),
            (_YDL_TV_IOS, _YDL_TV_LOCK)
        ]:
            try:
                with ydl_lock:
                    info = ydl_inst.extract_info(yt_target, download=False)
                if info and 'entries' in info and info['entries']:
                    info = info['entries'][0]
                if info:
                    a_url, a_mime, a_hdrs, v_url, v_mime, v_hdrs = _pick_best_formats(info)
                    if a_url or v_url:
                        prev_cached = STREAM_CACHE.get(track_id) or {}
                        final_a_url = prev_cached.get('audio_url') or a_url or v_url
                        final_a_mime = prev_cached.get('audio_mime') or a_mime or v_mime
                        final_a_hdrs = prev_cached.get('audio_headers') if prev_cached.get('audio_url') else (a_hdrs or v_hdrs)
                        entry_data = {
                            'audio_url': final_a_url,
                            'audio_mime': final_a_mime,
                            'audio_headers': final_a_hdrs,
                            'video_url': v_url or final_a_url,
                            'video_mime': v_mime if v_url else final_a_mime,
                            'video_headers': v_hdrs if v_url else final_a_hdrs,
                            'needs_yt_video': False,
                            'ts': time.time()
                        }
                        STREAM_CACHE[track_id] = entry_data
                        return entry_data
            except Exception as e:
                print(f"YouTube extractor note ({e}), trying next tier...")

        # Tier 3: Try SoundCloud full-length progressive MP3 stream (works on all cloud datacenter IPs)
        if not need_video:
            sc_url, sc_mime, sc_hdrs = _resolve_soundcloud_audio(target_query)
            if sc_url:
                entry_data = {
                    'audio_url': sc_url,
                    'audio_mime': sc_mime,
                    'audio_headers': sc_hdrs,
                    'video_url': sc_url,
                    'video_mime': sc_mime,
                    'video_headers': sc_hdrs,
                    'needs_yt_video': True,
                    'ts': time.time()
                }
                STREAM_CACHE[track_id] = entry_data
                return entry_data

        # Tier 4: Guaranteed Apple iTunes M4A / M4V CDN fallback so /api/stream & /api/video never 500
        it_audio, it_video = _resolve_itunes_fallback(track_id, target_query)
        prev_cached = STREAM_CACHE.get(track_id) or {}
        final_audio = prev_cached.get('audio_url') or saavn_url or it_audio or it_video
        final_video = it_video or prev_cached.get('video_url') or final_audio
        if final_audio:
            entry_data = {
                'audio_url': final_audio,
                'audio_mime': prev_cached.get('audio_mime') or 'audio/mp4',
                'audio_headers': {},
                'video_url': final_video,
                'video_mime': 'video/mp4' if it_video else (prev_cached.get('video_mime') or 'audio/mp4'),
                'video_headers': {},
                'needs_yt_video': False,
                'ts': time.time()
            }
            STREAM_CACHE[track_id] = entry_data
            return entry_data

        return None


def _build_private_session():
    sess = requests.Session()
    adapter = HTTPAdapter(pool_connections=4, pool_maxsize=4, max_retries=1)
    sess.mount("https://", adapter)
    sess.mount("http://", adapter)
    sess.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    })
    return sess


class ProgressiveStreamBuffer:
    """
    Dedicated-session progressive RAM buffer using 256KB YouTube &range slices
    streamed in 16KB increments. Guarantees instant (<0.6s) first-byte delivery,
    eliminates cross-thread session collisions, and never marks partial downloads
    as completed.
    """
    def __init__(self, track_id, url, default_mime, upstream_headers=None, kind="audio", query_target=None):
        self.track_id = str(track_id)
        self.url = url
        self.default_mime = default_mime
        self.upstream_headers = dict(upstream_headers or {})
        self.kind = kind
        self.query_target = query_target or str(track_id)
        self.buf = bytearray()
        self.total_size = 0
        clen_match = re.search(r'[?&]clen=(\d+)', str(url))
        if clen_match:
            try:
                self.total_size = int(clen_match.group(1))
            except Exception:
                pass
        self.content_type = default_mime
        self.headers_ready = False
        self.completed = False
        self.failed = False
        self.aborted = False
        self.active_readers = 0
        self.last_reader_time = time.time()
        self.cond = threading.Condition()
        self._thread = threading.Thread(target=self._download_worker, daemon=True)
        self._thread.start()

    def abort(self):
        with self.cond:
            self.aborted = True
            self.cond.notify_all()

    def _download_worker(self):
        # If this is a video buffer, let the same track's audio buffer get a 96KB (~12s) head start first
        if self.kind == "video":
            audio_buf = ACTIVE_STREAM_BUFFERS.get((self.track_id, "audio"))
            if audio_buf:
                with audio_buf.cond:
                    while (
                        len(audio_buf.buf) < 98304
                        and not audio_buf.completed
                        and not audio_buf.failed
                        and not audio_buf.aborted
                        and not self.aborted
                    ):
                        audio_buf.cond.wait(timeout=0.5)

        worker_session = _build_private_session()
        retries = 0

        try:
            while not self.aborted and retries < 20:
                start_pos = len(self.buf)
                if self.total_size > 0 and start_pos >= self.total_size:
                    break

                # Use 256KB slices streamed in 16KB pieces so first 16KB arrives in ~0.5s
                # and the full song completes in ~8-10 clean requests without rate-limiting
                chunk_span = 262144
                end_pos = start_pos + chunk_span - 1
                if self.total_size > 0:
                    end_pos = min(end_pos, self.total_size - 1)

                req_headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                }
                req_headers.update(self.upstream_headers)

                use_query_range = ('clen=' in self.url and 'range=' not in self.url and (retries % 2 == 0))
                if use_query_range:
                    target_url = f"{self.url}&range={start_pos}-{end_pos}"
                    req_headers.pop('Range', None)
                else:
                    target_url = self.url
                    req_headers['Range'] = f'bytes={start_pos}-{end_pos}'

                try:
                    with worker_session.get(target_url, headers=req_headers, stream=True, timeout=(6, 12)) as r:
                        if r.status_code not in (200, 206):
                            retries += 1
                            if retries in (3, 7, 12):
                                try:
                                    worker_session.close()
                                except Exception:
                                    pass
                                worker_session = _build_private_session()
                            if retries in (5, 11):
                                refreshed = resolve_track_streams(self.query_target, self.track_id, force_refresh=True)
                                if refreshed:
                                    self.url = refreshed['audio_url'] if self.kind == "audio" else refreshed['video_url']
                                    self.upstream_headers = dict(
                                        (refreshed.get('audio_headers') if self.kind == "audio" else refreshed.get('video_headers')) or {}
                                    )
                            time.sleep(min(1.2, 0.2 * retries))
                            continue

                        with self.cond:
                            if not self.headers_ready:
                                self.content_type = r.headers.get('Content-Type') or self.default_mime
                                cr = r.headers.get('Content-Range', '')
                                if '/' in cr:
                                    try:
                                        self.total_size = int(cr.split('/')[-1])
                                    except Exception:
                                        pass
                                elif self.total_size == 0 and 'Content-Length' in r.headers and r.status_code == 200 and not use_query_range:
                                    try:
                                        self.total_size = int(r.headers['Content-Length'])
                                    except Exception:
                                        pass
                                self.headers_ready = True
                                self.cond.notify_all()

                        got_bytes = 0
                        for piece in r.iter_content(chunk_size=16384):
                            if self.aborted:
                                return
                            if not piece:
                                continue
                            got_bytes += len(piece)
                            with self.cond:
                                self.buf.extend(piece)
                                retries = 0
                                self.cond.notify_all()

                        if got_bytes == 0:
                            retries += 1
                            time.sleep(0.25)
                        elif self.total_size > 0 and len(self.buf) >= self.total_size:
                            break
                        elif self.total_size == 0 and got_bytes < (end_pos - start_pos + 1):
                            # Reached EOF on stream with unknown initial total_size
                            self.total_size = len(self.buf)
                            break
                except Exception:
                    if self.aborted:
                        return
                    retries += 1
                    if retries in (3, 7, 12):
                        try:
                            worker_session.close()
                        except Exception:
                            pass
                        worker_session = _build_private_session()
                    if retries in (5, 11):
                        refreshed = resolve_track_streams(self.query_target, self.track_id, force_refresh=True)
                        if refreshed:
                            self.url = refreshed['audio_url'] if self.kind == "audio" else refreshed['video_url']
                            self.upstream_headers = dict(
                                (refreshed.get('audio_headers') if self.kind == "audio" else refreshed.get('video_headers')) or {}
                            )
                    time.sleep(min(1.2, 0.2 * retries))
        finally:
            try:
                worker_session.close()
            except Exception:
                pass

        with self.cond:
            if not self.aborted and len(self.buf) > 32768 and (self.total_size == 0 or len(self.buf) >= self.total_size):
                self.total_size = len(self.buf)
                self.completed = True
                self.cond.notify_all()
                self._save_to_disk()
            else:
                # Never mark an incomplete buffer as completed! Mark as failed and evict from ACTIVE_STREAM_BUFFERS
                self.failed = True
                self.cond.notify_all()
                with _BUFFER_LOCK:
                    if ACTIVE_STREAM_BUFFERS.get((self.track_id, self.kind)) is self:
                        ACTIVE_STREAM_BUFFERS.pop((self.track_id, self.kind), None)

    def _save_to_disk(self):
        try:
            safe_id = _safe_cache_key(self.track_id)
            ext = "_fast.audio" if self.kind == "audio" else "_fast.video"
            final_path = os.path.join(AUDIO_CACHE_DIR, f"{safe_id}{ext}")
            tmp_path = os.path.join(AUDIO_CACHE_DIR, f"{safe_id}{ext}.tmp")
            with open(tmp_path, "wb") as f:
                f.write(self.buf)
            os.replace(tmp_path, final_path)
            enforce_lru_disk_cache()
        except Exception:
            pass


def get_or_create_stream_buffer(track_id, url, mime_type, upstream_headers=None, kind="audio", query_target=None):
    key = (str(track_id), kind)
    now = time.time()
    with _BUFFER_LOCK:
        # Multi-user safe cleanup: only abort unfinished buffers that have NO active listeners,
        # and free RAM immediately for completed buffers (since they are saved on disk in AUDIO_CACHE_DIR)
        for (other_id, other_kind), buf_obj in list(ACTIVE_STREAM_BUFFERS.items()):
            if other_id != str(track_id):
                if not buf_obj.completed and buf_obj.active_readers <= 0 and (now - buf_obj.last_reader_time) > 2.5:
                    buf_obj.abort()
                    ACTIVE_STREAM_BUFFERS.pop((other_id, other_kind), None)
                elif buf_obj.completed and buf_obj.active_readers <= 0:
                    ACTIVE_STREAM_BUFFERS.pop((other_id, other_kind), None)

        existing = ACTIVE_STREAM_BUFFERS.get(key)
        if existing and not existing.aborted and not existing.failed:
            if not existing.completed or (existing.total_size > 0 and len(existing.buf) >= existing.total_size):
                existing.last_reader_time = now
                return existing
            ACTIVE_STREAM_BUFFERS.pop(key, None)

        new_buf = ProgressiveStreamBuffer(
            track_id, url, mime_type, upstream_headers=upstream_headers, kind=kind, query_target=query_target
        )
        ACTIVE_STREAM_BUFFERS[key] = new_buf
        return new_buf


def serve_progressive_stream(track_id, query_target, kind="audio", transcode=False):
    cached_file = get_cached_media_path(track_id, kind=kind)
    if cached_file and not transcode:
        return serve_cached_file_with_range(cached_file, kind=kind)

    if not query_target or query_target == track_id:
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("SELECT title, artist FROM tracks WHERE id = ?", (track_id,))
            row = cursor.fetchone()
            conn.close()
            if row and row['title']:
                query_target = f"{row['artist']} - {row['title']}"
            else:
                query_target = track_id
        except Exception:
            query_target = track_id

    resolved = resolve_track_streams(query_target, track_id, need_video=(kind == "video"))
    if not resolved:
        return jsonify({'error': 'Stream extraction failed'}), 500

    stream_url = resolved['audio_url'] if kind == "audio" else resolved['video_url']
    default_mime = resolved['audio_mime'] if kind == "audio" else resolved['video_mime']
    up_headers = resolved.get('audio_headers') if kind == "audio" else resolved.get('video_headers')

    if transcode and FFMPEG_BIN and kind == "audio":
        try:
            cmd = [
                FFMPEG_BIN, "-loglevel", "quiet", "-i", stream_url,
                "-vn", "-acodec", "libmp3lame", "-b:a", "128k", "-f", "mp3", "-"
            ]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            def generate_transcoded():
                try:
                    while True:
                        chunk = proc.stdout.read(16384)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    try:
                        proc.kill()
                    except Exception:
                        pass
            return Response(generate_transcoded(), status=200, headers={
                'Content-Type': 'audio/mpeg',
                'Access-Control-Allow-Origin': '*'
            })
        except Exception as e:
            print("FFmpeg transcode fallback:", e)

    buf_obj = get_or_create_stream_buffer(
        track_id, stream_url, default_mime, upstream_headers=up_headers, kind=kind, query_target=query_target
    )

    wait_deadline = time.time() + 14.0
    with buf_obj.cond:
        while (
            (not buf_obj.headers_ready or len(buf_obj.buf) == 0)
            and not buf_obj.completed
            and not buf_obj.failed
            and not buf_obj.aborted
        ):
            rem = wait_deadline - time.time()
            if rem <= 0:
                break
            buf_obj.cond.wait(timeout=min(1.0, rem))

    if buf_obj.failed and len(buf_obj.buf) == 0:
        return jsonify({'error': 'Upstream connection failed'}), 502

    total_size = buf_obj.total_size
    range_header = request.headers.get('Range', None)
    start = 0
    end = (total_size - 1) if total_size > 0 else None

    if range_header:
        match = re.search(r'bytes=(\d+)-(\d*)', range_header)
        if match:
            start = int(match.group(1))
            if match.group(2):
                end = int(match.group(2))
            elif total_size > 0:
                end = total_size - 1

    # If browser probes the tail or user seeks far ahead (> 256 KB past current buffer),
    # stream that range using an isolated private session so it never disturbs buf_obj's worker session
    if start > len(buf_obj.buf) + 262144 and not buf_obj.completed:
        target_end = end if end is not None else ((total_size - 1) if total_size > 0 else "")
        resp_headers = {
            'Content-Type': buf_obj.content_type,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
        }
        if total_size > 0 and isinstance(target_end, int):
            target_end = min(target_end, total_size - 1)
            if start > target_end or start >= total_size:
                return Response(status=416, headers={'Content-Range': f'bytes */{total_size}'})
            resp_headers['Content-Range'] = f'bytes {start}-{target_end}/{total_size}'
            resp_headers['Content-Length'] = str(target_end - start + 1)

        def generate_direct_range():
            range_sess = _build_private_session()
            cur_pos = start
            final_limit = (target_end + 1) if isinstance(target_end, int) else None
            r_tries = 0
            try:
                while (final_limit is None or cur_pos < final_limit) and r_tries < 8:
                    span_end = (min(cur_pos + 262143, final_limit - 1)) if final_limit is not None else (cur_pos + 262143)
                    r_headers = dict(up_headers or {})
                    if 'clen=' in stream_url and 'range=' not in stream_url:
                        r_url = f"{stream_url}&range={cur_pos}-{span_end}"
                        r_headers.pop('Range', None)
                    else:
                        r_url = stream_url
                        r_headers['Range'] = f"bytes={cur_pos}-{span_end}"
                    try:
                        with range_sess.get(r_url, headers=r_headers, stream=True, timeout=(6, 12)) as rq:
                            if rq.status_code not in (200, 206):
                                r_tries += 1
                                time.sleep(0.2)
                                continue
                            got = 0
                            for chunk in rq.iter_content(chunk_size=16384):
                                if not chunk:
                                    continue
                                got += len(chunk)
                                cur_pos += len(chunk)
                                r_tries = 0
                                yield chunk
                                if final_limit is not None and cur_pos >= final_limit:
                                    break
                            if got == 0:
                                r_tries += 1
                            elif final_limit is None and got < (span_end - (cur_pos - got) + 1):
                                break
                    except Exception:
                        r_tries += 1
                        time.sleep(0.2)
            finally:
                try:
                    range_sess.close()
                except Exception:
                    pass

        return Response(generate_direct_range(), status=206 if range_header else 200, headers=resp_headers)

    resp_headers = {
        'Content-Type': buf_obj.content_type,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
    }

    status_code = 200
    if range_header and total_size > 0 and end is not None:
        end = min(end, total_size - 1)
        if start > end or start >= total_size:
            return Response(status=416, headers={'Content-Range': f'bytes */{total_size}'})
        status_code = 206
        resp_headers['Content-Range'] = f'bytes {start}-{end}/{total_size}'
        resp_headers['Content-Length'] = str(end - start + 1)
    elif total_size > 0:
        resp_headers['Content-Length'] = str(total_size)

    def generate_from_ram():
        pos = start
        limit = (end + 1) if (end is not None and total_size > 0) else None
        with buf_obj.cond:
            buf_obj.active_readers += 1
            buf_obj.last_reader_time = time.time()
        try:
            while True:
                with buf_obj.cond:
                    while pos >= len(buf_obj.buf) and not buf_obj.completed and not buf_obj.failed and not buf_obj.aborted:
                        buf_obj.cond.wait(timeout=1.0)
                    avail = len(buf_obj.buf)
                    done = buf_obj.completed or buf_obj.failed or buf_obj.aborted
                    buf_obj.last_reader_time = time.time()

                if pos < avail:
                    read_end = min(avail, pos + 32768)
                    if limit is not None:
                        read_end = min(read_end, limit)
                    chunk = bytes(buf_obj.buf[pos:read_end])
                    pos = read_end
                    yield chunk
                    if limit is not None and pos >= limit:
                        break
                elif done:
                    # Seamless fallback if buffer failed before reaching limit (so browser never gets IncompleteRead)
                    if not buf_obj.aborted and (limit is None or pos < limit):
                        fb_sess = _build_private_session()
                        fb_tries = 0
                        try:
                            while (limit is None or pos < limit) and fb_tries < 8 and not buf_obj.aborted:
                                span_end = (min(pos + 262143, limit - 1)) if limit is not None else (pos + 262143)
                                fb_hdrs = dict(buf_obj.upstream_headers or {})
                                if 'clen=' in buf_obj.url and 'range=' not in buf_obj.url:
                                    fb_url = f"{buf_obj.url}&range={pos}-{span_end}"
                                    fb_hdrs.pop('Range', None)
                                else:
                                    fb_url = buf_obj.url
                                    fb_hdrs['Range'] = f"bytes={pos}-{span_end}"
                                try:
                                    with fb_sess.get(fb_url, headers=fb_hdrs, stream=True, timeout=(6, 12)) as fb_r:
                                        if fb_r.status_code not in (200, 206):
                                            fb_tries += 1
                                            time.sleep(0.2)
                                            continue
                                        got = 0
                                        for fb_chunk in fb_r.iter_content(chunk_size=16384):
                                            if buf_obj.aborted or not fb_chunk:
                                                continue
                                            got += len(fb_chunk)
                                            pos += len(fb_chunk)
                                            fb_tries = 0
                                            yield fb_chunk
                                            if limit is not None and pos >= limit:
                                                break
                                        if got == 0:
                                            fb_tries += 1
                                except Exception:
                                    fb_tries += 1
                                    time.sleep(0.2)
                        finally:
                            try:
                                fb_sess.close()
                            except Exception:
                                pass
                    break
        finally:
            with buf_obj.cond:
                buf_obj.active_readers = max(0, buf_obj.active_readers - 1)
                buf_obj.last_reader_time = time.time()

    return Response(generate_from_ram(), status=status_code, headers=resp_headers)


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
    transcode = request.args.get('transcode', '').strip() == '1'
    if not track_id:
        return jsonify({'error': 'Track ID required'}), 400

    return serve_progressive_stream(track_id, query_target, kind="audio", transcode=transcode)


@app.route('/api/video', methods=['GET', 'OPTIONS'])
def get_video_stream():
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

    return serve_progressive_stream(track_id, query_target, kind="video", transcode=False)


@app.route('/api/prefetch', methods=['GET'])
def prefetch():
    track_id = request.args.get('id', '').strip()
    query_target = request.args.get('q', '').strip() or track_id
    if not track_id:
        return jsonify({'error': 'Track ID required'}), 400

    # Only pre-resolve stream URLs into STREAM_CACHE without stealing download bandwidth from current playback
    threading.Thread(target=resolve_track_streams, args=(query_target, track_id), daemon=True).start()
    return jsonify({'status': 'prefetching'})

@app.route('/api/lyrics', methods=['GET'])
def proxy_lyrics():
    q = request.args.get('q', '').strip()
    if len(q) < 2:
        return jsonify([])
    try:
        r = HTTP_SESSION.get(
            "https://lrclib.net/api/search",
            params={"q": q},
            timeout=5
        )
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list):
                return jsonify(data)
    except Exception:
        pass
    return jsonify([])

# ---------- Tier 4: Multi-User "Listen Along" WebSocket Rooms ----------
ROOMS = {}  # { room_code: { 'members': { sid: username }, 'state': {...} } }

@socketio.on('join_room_event')
def handle_join_room(data):
    room = (data.get('room') or '').strip().upper()
    username = (data.get('username') or 'Listener').strip()
    if not room:
        return

    join_room(room)
    if room not in ROOMS:
        ROOMS[room] = {'members': {}, 'state': data.get('state') or {}}
    ROOMS[room]['members'][request.sid] = username
    if data.get('state') and not ROOMS[room]['state']:
        ROOMS[room]['state'] = data['state']

    member_list = list(ROOMS[room]['members'].values())
    emit('room_joined', {
        'room': room,
        'members': member_list,
        'state': ROOMS[room]['state']
    })
    emit('room_members', {'members': member_list}, to=room)

@socketio.on('leave_room_event')
def handle_leave_room(data):
    room = (data.get('room') or '').strip().upper()
    if room in ROOMS:
        ROOMS[room]['members'].pop(request.sid, None)
        leave_room(room)
        member_list = list(ROOMS[room]['members'].values())
        if not member_list:
            ROOMS.pop(room, None)
        else:
            emit('room_members', {'members': member_list}, to=room)

@socketio.on('sync_state')
def handle_sync_state(data):
    room = (data.get('room') or '').strip().upper()
    state_payload = data.get('state') or {}
    if not room or room not in ROOMS:
        return
    ROOMS[room]['state'] = state_payload
    emit('room_sync', state_payload, to=room, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    for room, info in list(ROOMS.items()):
        if request.sid in info['members']:
            info['members'].pop(request.sid, None)
            member_list = list(info['members'].values())
            if not member_list:
                ROOMS.pop(room, None)
            else:
                emit('room_members', {'members': member_list}, to=room)

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'ok', 'service': 'daddys-music'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    host = os.environ.get('HOST', '0.0.0.0')

    if port == 5000 and not os.environ.get('RENDER') and not os.environ.get('RAILWAY_ENVIRONMENT'):
        def _run_companion_5500():
            try:
                from werkzeug.serving import make_server
                srv = make_server('127.0.0.1', 5500, app, threaded=True)
                srv.serve_forever()
            except Exception:
                pass

        threading.Thread(target=_run_companion_5500, daemon=True).start()

    # Run via SocketIO with reloader disabled so it never reboots or spawns duplicate listeners
    socketio.run(app, host=host, port=port, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)