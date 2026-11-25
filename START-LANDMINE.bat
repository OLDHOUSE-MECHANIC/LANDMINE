@echo off
setlocal
title LANDMINE
cd /d "%~dp0"

rem Double-click this file on Windows. It sets up what is missing and runs the app.
rem If you put yt-dlp.exe in this folder, use it instead of a system install.
if exist "%~dp0yt-dlp.exe" set "YTDLP_PATH=%~dp0yt-dlp.exe"

echo.
echo   LANDMINE
echo   ============================================
echo   The first run can take a few minutes.
echo.

call :refreshpath

echo   Checking Node.js 20+ ...
where node >nul 2>nul
if errorlevel 1 goto installnode
set "NODEVER="
for /f "tokens=1 delims=v" %%v in ('node -v 2^>nul') do set "NODEVER=%%v"
if not defined NODEVER goto installnode
set /a NODEMAJOR=0
for /f "delims=." %%m in ("%NODEVER%") do set /a NODEMAJOR=%%m
if %NODEMAJOR% GEQ 20 goto haveNode

:installnode
echo   Node.js 20+ not found. Trying to install the LTS version with winget...
call :winget "OpenJS.NodeJS.LTS"
call :refreshpath
set "NODEVER="
for /f "tokens=1 delims=v" %%v in ('node -v 2^>nul') do set "NODEVER=%%v"
if defined NODEVER (
  set /a NODEMAJOR=0
  for /f "delims=." %%m in ("%NODEVER%") do set /a NODEMAJOR=%%m
)
if %NODEMAJOR% GEQ 20 goto nodeok
echo   Trying to upgrade the Node.js that is already installed...
winget upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
call :refreshpath
set "NODEVER="
for /f "tokens=1 delims=v" %%v in ('node -v 2^>nul') do set "NODEVER=%%v"
if defined NODEVER (
  set /a NODEMAJOR=0
  for /f "delims=." %%m in ("%NODEVER%") do set /a NODEMAJOR=%%m
)
if %NODEMAJOR% GEQ 20 goto nodeok

echo.
echo   Could not set up Node.js automatically.
echo   1. Open https://nodejs.org and install the LTS version.
echo   2. Double-click this file again.
echo.
start "" https://nodejs.org/
pause
exit /b 1

:nodeok
echo   [ok] Node.js %NODEVER%

:haveNode
echo   Checking yt-dlp ...
set "HAVEYT="
if defined YTDLP_PATH if exist "%YTDLP_PATH%" set "HAVEYT=1"
if not defined HAVEYT (
  where yt-dlp >nul 2>nul
  if not errorlevel 1 set "HAVEYT=1"
)
if not defined HAVEYT (
  echo   yt-dlp not found. Trying to install it with winget...
  call :winget "yt-dlp.yt-dlp"
  call :refreshpath
  where yt-dlp >nul 2>nul
  if not errorlevel 1 set "HAVEYT=1"
)
if not defined HAVEYT (
  echo.
  echo   Could not set up yt-dlp automatically.
  echo   Download yt-dlp.exe from the page that opens, put it in this
  echo   folder, then double-click this file again.
  echo.
  start "" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
  pause
  exit /b 1
)
echo   [ok] yt-dlp

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo   [ok] Created .env from .env.example
  )
)

echo   Checking the app's libraries ^(npm install^) ...
call npm install
if errorlevel 1 goto npmfail

set "APP_PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /i "PORT=" ".env"`) do set "APP_PORT=%%B"
)
set "APP_PORT=%APP_PORT: =%"

echo   Opening the browser in a few seconds ...
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 5; Start-Process ('http://localhost:' + '%APP_PORT%')"

echo.
echo   LANDMINE is starting. Keep this window open.
echo   To stop it: close this window, or press Ctrl+C.
echo.
call npm start

echo.
echo   LANDMINE has stopped.
pause
exit /b 0

:npmfail
echo.
echo   npm install failed. Check your internet connection and try again.
pause
exit /b 1

:refreshpath
for /f "tokens=*" %%P in ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"') do set "PATH=%%P"
exit /b 0

:winget
where winget >nul 2>nul
if errorlevel 1 exit /b 1
winget install --id "%~1" -e --accept-source-agreements --accept-package-agreements
exit /b 0
