@echo off
REM 启动 AI剪辑工作台 v0.1（桌面窗口壳子）
cd /d "%~dp0"
REM 先杀干净残留的 main.py 进程：旧进程不退出会继续占用 8080 端口（allow_reuse_port 允许多进程同绑），
REM 新窗口连接会被旧进程随机接走——表现为"改了代码没生效/行为随机"。必须清干净再起。
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*main.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
call .venv\Scripts\python.exe main.py
pause
