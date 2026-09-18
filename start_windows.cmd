@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Virtual environment was not found.
  echo Run setup_windows.cmd first.
  exit /b 1
)

if "%FOUP_HOST%"=="" set "FOUP_HOST=0.0.0.0"
if "%FOUP_PORT%"=="" set "FOUP_PORT=8000"

echo [FOUP] Starting server at http://127.0.0.1:%FOUP_PORT%

if exist ".env" (
  ".venv\Scripts\python.exe" -m uvicorn app.main:app --host "%FOUP_HOST%" --port "%FOUP_PORT%" --env-file ".env"
) else (
  ".venv\Scripts\python.exe" -m uvicorn app.main:app --host "%FOUP_HOST%" --port "%FOUP_PORT%"
)

exit /b %errorlevel%
