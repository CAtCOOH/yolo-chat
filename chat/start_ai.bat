@echo off
rem ============================================================
rem  One-click launcher: Dify (optional) + chat backend + frontend
rem
rem  This file is intentionally PURE ASCII, exactly like the old
rem  start.bat that was known to work. cmd.exe reads .bat files
rem  byte-by-byte with the OEM code page (GBK on Chinese Windows),
rem  so a UTF-8 .bat containing Chinese turns into garbage and the
rem  whole script dies at once. Chinese documentation lives in the
rem  .md files instead.
rem
rem  Waits use "ping" rather than "timeout": timeout aborts with
rem  "input redirection is not supported" when stdin is not a
rem  console, which would silently skip the wait.
rem ============================================================

setlocal
cd /d "%~dp0"

echo Current dir: %cd%
echo.

rem ---------- 1. Start Dify (optional, text AI) ----------
echo [1/3] Trying to start Dify (safe to ignore if not installed)...
wsl -d Ubuntu-22.04 -e bash -c "cd ~/dify/docker && docker compose up -d" >nul 2>nul
if errorlevel 1 (
    echo       Dify not started. Chat room still works, just no AI reply.
) else (
    echo       Waiting for Dify...
    ping -n 11 127.0.0.1 >nul
)

rem ---------- 2. Check prerequisites ----------
where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist server.js goto no_server

if not exist node_modules (
    echo [2/3] Installing Node dependencies, first run may take a while...
    call npm install
) else (
    echo [2/3] Node dependencies ready.
)

rem ---------- 3. Start backend ----------
rem The backend serves WebSocket chat, the image upload endpoint and
rem the images themselves, and loads the YOLO model at startup.
rem "cmd /k" keeps the window open even if node crashes, so any error
rem stays readable instead of vanishing.
echo [3/3] Starting backend with YOLO auto-detection...
start "chat-backend" cmd /k node server.js

rem ---------- 4. Start frontend ----------
where py >nul 2>nul
if errorlevel 1 goto no_py

start "chat-frontend" cmd /k py -m http.server 8080

rem Give both servers a moment to bind their ports. Loading the YOLO
rem model takes a few seconds, but the page reconnects on its own, so
rem being a little early is harmless.
echo       Waiting for the servers to come up...
ping -n 9 127.0.0.1 >nul

start "" http://localhost:8080/index.html
goto done

:no_node
echo [ERROR] Node.js not found. Please install it first.
echo.
pause
exit /b 1

:no_server
echo [ERROR] server.js not found. Run this file from inside the project folder.
echo.
pause
exit /b 1

:no_py
echo [INFO] Python not found. Opening the page as a local file instead.
echo        Chat and image upload still work.
ping -n 3 127.0.0.1 >nul
start "" index.html
goto done

:done
echo.
echo Two windows should now be open: "chat-backend" and "chat-frontend".
echo Keep them open. Closing the backend drops all connections.
echo.
echo If the page opens but chat does not work, or nothing appeared at all,
echo run  diagnose.bat  and it will write a report to diagnose.log
echo.
pause
