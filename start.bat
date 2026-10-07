@echo off
cd /d %~dp0

echo Current dir: %cd%
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist server.js goto no_server

if exist node_modules goto skip_install
echo Installing dependencies...
call npm install
:skip_install

echo Starting backend...
start "backend" cmd /k node server.js

where py >nul 2>nul
if errorlevel 1 goto no_py

echo Starting frontend...
start "frontend" cmd /k py -m http.server 8080
timeout /t 2 /nobreak >nul
start "" http://localhost:8080/index.html
goto done

:no_node
echo [ERROR] node not found. Please install Node.js.
pause
exit /b 1

:no_server
echo [ERROR] server.js not found in current dir.
pause
exit /b 1

:no_py
echo [INFO] py not found. Opening index.html directly.
timeout /t 2 /nobreak >nul
start "" index.html
goto done

:done
echo Done.
pause