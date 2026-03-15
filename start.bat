@echo off
title tboard
echo Starting tboard ...

:: Start WSL server in background
start /b wsl.exe bash -c "cd ~/pjt/terminal-tool && PORT=51731 VITE_PORT=51730 npm run dev"

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
echo   Frontend : http://127.0.0.1:51730
echo   Backend  : http://127.0.0.1:51731
echo.
pause
