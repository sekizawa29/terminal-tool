@echo off
title tboard
setlocal enabledelayedexpansion

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo WSL is not available on this machine.
  exit /b 1
)

:: Resolve the WSL path of this script's directory
set "SCRIPT_DIR=%~dp0"
if "!SCRIPT_DIR:~-1!"=="\" set "SCRIPT_DIR=!SCRIPT_DIR:~0,-1!"

:: UNC path (\\wsl.localhost\Distro\... or \\wsl$\Distro\...): parse directly
:: Normal Windows path (C:\...): convert via wslpath
echo !SCRIPT_DIR! | findstr /i /b "\\\\wsl" >nul 2>nul
if not errorlevel 1 (
  for /f "tokens=1,2,* delims=\" %%a in ("!SCRIPT_DIR:~2!") do set "REST=%%c"
  set "WSL_DIR=/!REST:\=/!"
) else (
  for /f "usebackq tokens=*" %%i in (`wsl.exe wslpath -u "!SCRIPT_DIR!"`) do set "WSL_DIR=%%i"
)

if "!WSL_DIR!"=="" (
  echo ERROR: Could not determine WSL path.
  exit /b 1
)

echo Starting tboard in WSL ...
echo.

:: start.sh does its own cd, so invoke it directly by full path
wsl.exe bash -ic "exec '!WSL_DIR!/start.sh'"
