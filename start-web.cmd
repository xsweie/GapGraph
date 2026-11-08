@echo off
chcp 65001 >nul
title KnowMap 浏览器版
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 npm，请先安装 Node.js。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 首次运行，正在安装依赖...
  call npm install --ignore-scripts
  if errorlevel 1 ( echo [错误] 安装失败 & pause & exit /b 1 )
)

echo.
echo 正在启动 KnowMap（浏览器版）...
echo 启动后浏览器会自动打开 http://localhost:5180
echo 关闭本窗口即停止服务。
echo.
call npm run dev:web

echo.
echo 服务已停止。若上方有红色报错，请截图反馈。
pause
