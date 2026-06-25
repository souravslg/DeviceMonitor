@echo off
title NetWatch - Device Monitor
echo.
echo  Starting NetWatch proxy server...
echo.

:: Try node in common locations
where node >nul 2>&1
if %ERRORLEVEL% == 0 (
    node "%~dp0proxy.js"
    goto :end
)

:: Try full paths
for %%P in (
    "C:\Program Files\nodejs\node.exe"
    "C:\Program Files (x86)\nodejs\node.exe"
    "%APPDATA%\nvm\current\node.exe"
) do (
    if exist %%P (
        %%P "%~dp0proxy.js"
        goto :end
    )
)

:: Node not found — open file directly as fallback
echo  Node.js not found. Opening app directly in browser.
echo  NOTE: Live UPS data will be unavailable without the proxy.
echo  Install Node.js from https://nodejs.org/ to enable live data.
echo.
start "" "%~dp0index.html"

:end
pause
