@echo off
setlocal
set "ROOT=%~dp0"
set "SCRIPT=%ROOT%scripts\release-manager.ps1"

if not exist "%SCRIPT%" (
  echo [ERROR] Cannot find script: %SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [INFO] Script exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
