@echo off
title tboard

set "WSL_DIR=/home/sekiz/pjt/terminal-tool"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo WSL is not available on this machine.
  exit /b 1
)

echo Starting tboard in WSL ...
echo.

:: Use an interactive shell so ~/.bashrc is loaded and nvm-managed node is available.
wsl.exe --cd "%WSL_DIR%" bash -ic "exec ./start.sh"
