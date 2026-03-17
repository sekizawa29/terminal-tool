@echo off
title tboard
cd /d "%~dp0"

echo Starting tboard ...
echo   Frontend : http://127.0.0.1:51730
echo   Backend  : http://127.0.0.1:51731
echo.

:: Install dependencies if needed
if not exist node_modules (
  echo Installing dependencies ...
  call npm install
  echo.
)

:: Start dev server in background
set PORT=51731
set VITE_PORT=51730
start /b npm run dev

:: Wait for Vite to be ready
echo Waiting for server...
:loop
timeout /t 1 /nobreak >nul
curl -s -o nul http://127.0.0.1:51730 2>nul
if errorlevel 1 goto loop

:: Open browser
echo Opening browser...
start http://127.0.0.1:51730

echo.
echo tboard is running. Close this window to stop.
echo.
pause
