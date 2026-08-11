@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0GX-EQ.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0GX-EQ.ps1"
) else (
  echo.
  echo Missing GX-EQ.ps1
  echo.
  pause
  exit /b 1
)
if errorlevel 1 (
  echo.
  echo Update failed. Check the error output above.
) else (
  echo.
  echo EQ library refresh completed.
)
echo.
pause
