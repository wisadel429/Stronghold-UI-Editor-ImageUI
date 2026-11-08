@echo off
chcp 65001 >nul
title Stronghold UI Layout Editor
cd /d "%~dp0"

rem --- Built-in browser host (WebView2). The console closes right away; the GUI window stays. ---
if not exist "%~dp0StrongholdUIEditor.exe" (
  echo.
  echo   [X] StrongholdUIEditor.exe is missing.
  echo       Run build-host.ps1 once, or unpack the packaged copy again.
  echo.
  pause
  exit /b 1
)

start "" "%~dp0StrongholdUIEditor.exe" %*
exit /b 0
