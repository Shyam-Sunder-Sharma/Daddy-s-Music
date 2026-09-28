@echo off
title Daddy's Music — Backend Server
cd /d "%~dp0"
echo Starting Daddy's Music Backend Server on http://127.0.0.1:5000 ...
start "" "http://127.0.0.1:5000"
"C:\Users\shyam\AppData\Local\Programs\Python\Python313\python.exe" -B backend\app.py
pause
