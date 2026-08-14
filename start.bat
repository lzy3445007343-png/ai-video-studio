@echo off
REM 启动 AI剪辑工作台 v0.1（桌面窗口壳子）
cd /d "%~dp0"
call .venv\Scripts\python.exe main.py
pause
