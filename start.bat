@echo off
title tboard

echo Starting tboard ...
echo   Frontend : http://127.0.0.1:51730
echo   Backend  : http://127.0.0.1:51731
echo.

set "WSL_DIR=/home/sekiz/pjt/terminal-tool"

:: Install dependencies if needed
wsl bash -c "cd %WSL_DIR% && [ -d node_modules ] || npm install"

:: Start dev server via WSL in background
start /b wsl bash -c "cd %WSL_DIR% && PORT=51731 VITE_PORT=51730 npm run dev"

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
