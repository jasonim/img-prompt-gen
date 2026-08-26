@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 22 或 24 LTS：https://nodejs.org/
  echo 安装后重新双击此文件。
  pause
  exit /b 1
)
node server\index.js
echo.
echo 服务已停止。
pause
