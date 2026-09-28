"""
auth.py — Standalone authentication module for Daddy's Music
"""

import os
import sys
import re
import sqlite3
import secrets
from datetime import datetime, timedelta
from functools import wraps
from flask import Blueprint, request, jsonify, g
from werkzeug.security import generate_password_hash, check_password_hash

sys.dont_write_bytecode = True

DATA_DIR = os.path.join(os.path.expanduser("~"), ".daddys_music_data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "music.db")

TOKEN_LIFETIME_DAYS = 30
USERNAME_RE = re.compile(r'^[a-zA-Z0-9_]{3,20}$')

auth_bp = Blueprint('auth', __name__, url_prefix='/api/auth')

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_auth_db(custom_path=None):
    global DB_PATH
    if custom_path:
        DB_PATH = custom_path
    conn = get_db()
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            username_lower TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    ''')
    conn.commit()
    conn.close()

def validate_username(username):
    if not username or not USERNAME_RE.match(username):
        return "Username must be 3-20 characters: letters, numbers, or underscores only."
    return None

def validate_password(password):
    if not password or len(password) < 8:
        return "Password must be at least 8 characters."
    if not re.search(r'[A-Z]', password):
        return "Password needs at least one uppercase letter."
    if not re.search(r'[a-z]', password):
        return "Password needs at least one lowercase letter."
    if not re.search(r'[0-9]', password):
        return "Password needs at least one number."
    if not re.search(r'[!@#$%^&*()\-_=+\[\]{};:,.<>/?~`|\\]', password):
        return "Password needs at least one special character."
    return None

def make_token(user_id):
    token = secrets.token_hex(32)
    now = datetime.utcnow()
    expires = now + timedelta(days=TOKEN_LIFETIME_DAYS)
    conn = get_db()
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (token, user_id, now.isoformat(), expires.isoformat())
    )
    conn.commit()
    conn.close()
    return token

def get_user_from_token(token):
    if not token:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT s.user_id AS id, s.expires_at, u.username FROM sessions s "
        "JOIN users u ON u.id = s.user_id WHERE s.token = ?", (token,)
    ).fetchone()
    conn.close()
    if not row:
        return None
    if datetime.fromisoformat(row['expires_at']) < datetime.utcnow():
        return None
    return {'id': row['id'], 'username': row['username']}

def _extract_token():
    auth_header = request.headers.get('Authorization', '') or request.headers.get('authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:].strip()
    return None

def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = get_user_from_token(_extract_token())
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        g.current_user = user
        return f(*args, **kwargs)
    return wrapper

@auth_bp.route('/check-username', methods=['GET'])
def check_username():
    username = (request.args.get('u') or '').strip()
    err = validate_username(username)
    if err:
        return jsonify({'available': False, 'error': err})
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM users WHERE username_lower = ?", (username.lower(),)
    ).fetchone()
    conn.close()
    return jsonify({'available': row is None})

@auth_bp.route('/register', methods=['POST'])
def register():
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    err = validate_username(username)
    if err:
        return jsonify({'error': err}), 400

    err = validate_password(password)
    if err:
        return jsonify({'error': err}), 400

    conn = get_db()
    c = conn.cursor()
    try:
        c.execute(
            "INSERT INTO users (username, username_lower, password_hash, created_at) "
            "VALUES (?, ?, ?, ?)",
            (username, username.lower(), generate_password_hash(password), datetime.utcnow().isoformat())
        )
        conn.commit()
        user_id = c.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': 'That username is already taken.'}), 409
    conn.close()

    token = make_token(user_id)
    return jsonify({'user': {'id': user_id, 'username': username}, 'token': token})

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.json or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    if not username or not password:
        return jsonify({'error': 'Username and password required.'}), 400

    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE username_lower = ?", (username.lower(),)
    ).fetchone()
    conn.close()

    if not row or not check_password_hash(row['password_hash'], password):
        return jsonify({'error': 'Incorrect username or password.'}), 401

    token = make_token(row['id'])
    return jsonify({'user': {'id': row['id'], 'username': row['username']}, 'token': token})

@auth_bp.route('/logout', methods=['POST'])
@require_auth
def logout():
    conn = get_db()
    conn.execute("DELETE FROM sessions WHERE token = ?", (_extract_token(),))
    conn.commit()
    conn.close()
    return jsonify({'status': 'logged out'})

@auth_bp.route('/me', methods=['GET'])
@require_auth
def me():
    return jsonify({'user': g.current_user})