@echo off
rem Double-click this file to start the English Notebook local sync server.
rem The window stays open after the server stops.
setlocal
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_EXE=%%i"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"

if not defined NODE_EXE (
    echo [ERROR] node.exe was not found. Install Node.js and add it to PATH.
    echo Download: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Starting English Notebook local sync server...
echo Using Node: %NODE_EXE%
echo Press Ctrl+C to stop. The window stays open afterwards.
echo.

"%NODE_EXE%" "%~dp0sync-server.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Server stopped. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
