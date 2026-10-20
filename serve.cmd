@echo off
rem Local test server: open http://localhost:8080 in Chrome or Edge.
rem (The microphone only works on localhost or HTTPS.)
cd /d "%~dp0"
python -m http.server 8080
