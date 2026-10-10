@echo off
rem ============================================================
rem  Diagnostic helper. Pure ASCII on purpose (see start_ai.bat).
rem
rem  Use this when start_ai.bat flashes and closes, or when the
rem  page opens but nothing works. It prints everything useful and
rem  also saves a copy to diagnose.log.
rem ============================================================

setlocal
cd /d "%~dp0"

set LOG=diagnose.log

echo ============================================================
echo   Chat room diagnostics
echo ============================================================
echo Current dir: %cd%
echo Log file   : %cd%\%LOG%
echo.

rem Restart the log file each run
echo ===== Chat room diagnostics ===== > "%LOG%"
echo Run at: %DATE% %TIME%>> "%LOG%"
echo Current dir: %cd%>> "%LOG%"

echo ---------- 1. Node.js ----------
node -v
if errorlevel 1 (
    echo   [PROBLEM] node not found in PATH
) else (
    echo   OK
)
echo. 
echo --- node -v --- >> "%LOG%"
node -v >> "%LOG%" 2>&1

echo ---------- 2. npm ----------
call npm -v
echo. 
echo --- npm -v --- >> "%LOG%"
call npm -v >> "%LOG%" 2>&1

echo ---------- 3. Python ----------
where py
if errorlevel 1 (
    echo   [PROBLEM] py not found
) else (
    echo   OK
)
echo. 
echo --- where py --- >> "%LOG%"
where py >> "%LOG%" 2>&1

echo ---------- 4. Python version ----------
py --version
echo. 
echo --- py --version --- >> "%LOG%"
py --version >> "%LOG%" 2>&1

echo ---------- 5. ultralytics (needed for YOLO) ----------
py -c "import ultralytics;print('ultralytics',ultralytics.__version__)"
if errorlevel 1 (
    echo   [PROBLEM] ultralytics missing. Run:  py -m pip install ultralytics
) else (
    echo   OK
)
echo. 
echo --- ultralytics --- >> "%LOG%"
py -c "import ultralytics;print('ultralytics',ultralytics.__version__)" >> "%LOG%" 2>&1

echo ---------- 6. Node dependencies ----------
if exist node_modules (
    echo   node_modules exists
) else (
    echo   [PROBLEM] node_modules missing. Run:  npm install
)
echo. 
echo --- dependency load test --- >> "%LOG%"
node -e "require('ws');require('better-sqlite3');console.log('ws + better-sqlite3 OK')" >> "%LOG%" 2>&1
type "%LOG%" | findstr /C:"OK" >nul
node -e "require('ws');require('better-sqlite3')" 2>nul
if errorlevel 1 (
    echo   [PROBLEM] ws or better-sqlite3 failed to load, run:  npm install
) else (
    echo   OK
)

echo ---------- 7. Model weights ----------
set FOUND=
if exist "train\runs\detect\train-2\weights\best.pt" set FOUND=train\runs\detect\train-2\weights\best.pt
if exist "..\train\runs\detect\train-2\weights\best.pt" set FOUND=..\train\runs\detect\train-2\weights\best.pt
if defined FOUND (
    echo   found: %FOUND%
) else (
    echo   [PROBLEM] best.pt not found next to this folder or one level up
)
echo. 
echo --- model search --- >> "%LOG%"
if defined FOUND echo found %FOUND%>> "%LOG%"

echo ---------- 8. Ports 3000 / 8080 ----------
netstat -ano | findstr /C:":3000 " | findstr /C:"LISTENING"
netstat -ano | findstr /C:":8080 " | findstr /C:"LISTENING"
echo   ^(no output above means the ports are free, which is what we want^)
echo. 
echo --- netstat 3000/8080 --- >> "%LOG%"
netstat -ano | findstr /C:":3000 " >> "%LOG%" 2>&1
netstat -ano | findstr /C:":8080 " >> "%LOG%" 2>&1

echo ---------- 9. server.js syntax ----------
if exist server.js (
    node --check server.js
    if errorlevel 1 (
        echo   [PROBLEM] server.js has a syntax error
    ) else (
        echo   OK
    )
) else (
    echo   [PROBLEM] server.js not found in this folder
)
echo. 
echo --- node --check server.js --- >> "%LOG%"
node --check server.js >> "%LOG%" 2>&1

echo ---------- 10. Quick backend smoke run (5s) ----------
echo   Starting server briefly to catch startup errors...
echo. 
echo --- backend startup output --- >> "%LOG%"
start /b cmd /c "node server.js > backend_test.log 2>&1"
timeout /t 8 /nobreak >nul
taskkill /f /im node.exe >nul 2>nul
timeout /t 1 /nobreak >nul
if exist backend_test.log (
    echo   --- backend_test.log ---
    type backend_test.log
    echo. 
    echo --- backend_test.log --- >> "%LOG%"
    type backend_test.log >> "%LOG%" 2>&1
) else (
    echo   [PROBLEM] backend produced no log at all
)

echo.
echo ============================================================
echo   Diagnostics finished. A copy was saved to:
echo   %cd%\%LOG%
echo   Also check backend_test.log
echo ============================================================
echo.
pause
