@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd run build
if errorlevel 1 goto failed
echo Open http://localhost:4173 after the service is ready.
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Context Bridge could not start. See the message above.
pause
exit /b 1
