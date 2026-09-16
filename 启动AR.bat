@echo off
title Start AR Hands
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LocalServer.ps1"
echo.
echo Server stopped. Press any key to close...
pause >nul
