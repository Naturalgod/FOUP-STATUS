@echo off
setlocal
cd /d "%~dp0"

echo [FOUP] Windows virtual environment setup

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m venv .venv
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Python 3.9 or newer is required.
    echo Install 64-bit Python and enable the PATH option, then run this file again.
    exit /b 1
  )
  python -m venv .venv
)

if errorlevel 1 goto :setup_error

".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :setup_error

echo.
echo [FOUP] Setup completed.
echo Run start_windows.cmd to start the server.
exit /b 0

:setup_error
echo.
echo [ERROR] Setup failed. Check the Python, proxy, and package repository settings.
exit /b 1
