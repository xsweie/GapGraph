@echo off
chcp 65001 >nul
title KnowMap 实时版（含 AI）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node，请先安装 Node.js。
  pause
  exit /b 1
)

if not exist "out\web\index.html" (
  echo 首次运行，正在构建前端...
  call npm run build:web
  if errorlevel 1 ( echo [错误] 构建失败 & pause & exit /b 1 )
)

echo.
echo 启动中，浏览器会自动打开 http://127.0.0.1:3300
echo 这个模式下「直接问 AI」可用（本地代理转发，不暴露密钥给页面）
echo 关闭本窗口即停止。
echo.
start "" http://127.0.0.1:3300
node scripts\ai-proxy.cjs
pause
