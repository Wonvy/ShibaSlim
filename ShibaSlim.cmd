@echo off
rem Windows: double-click to open the ShibaSlim window in your browser.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Node.js 20 或更高版本：https://nodejs.org
  pause
  exit /b 1
)
set NEEDS_INSTALL=
if not exist node_modules set NEEDS_INSTALL=1
if not exist dist\cli.js set NEEDS_INSTALL=1
if defined NEEDS_INSTALL (
  echo 首次运行，正在安装依赖…
  call npm install
  if errorlevel 1 (
    echo 安装失败
    pause
    exit /b 1
  )
)
node dist\cli.js gui
if errorlevel 1 pause
