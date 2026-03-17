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

:: Open in app mode (no address bar / bookmarks)
echo Opening app...
set "APP_URL=http://127.0.0.1:51730"
set "CHROME_PATH="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if defined CHROME_PATH (
  start "" "%CHROME_PATH%" --app=%APP_URL% --new-window
) else (
  :: Fallback to Edge (pre-installed on Windows)
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=%APP_URL% --new-window 2>nul || start %APP_URL%
)

echo.
echo tboard is running. Close this window to stop.
echo.
pause
