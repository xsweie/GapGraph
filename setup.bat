@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title GapGraph 初始化
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" setup
set "GG_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %GG_EXIT%
