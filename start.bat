@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title GapGraph 启动
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" start
set "GG_EXIT=%ERRORLEVEL%"
if not "%GG_EXIT%"=="0" pause
exit /b %GG_EXIT%
