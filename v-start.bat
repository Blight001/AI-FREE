@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AI-FREE Launcher

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to enter repo root.
  pause
  exit /b 1
)

rem Keep the account backend in its existing production mode. HeySure has an
rem independent forced profile so saved or inherited addresses cannot win.
set "AI_FREE_SERVER_MODE=remote"
set "HEYSURE_LOCAL_TEST=false"
set "HEYSURE_FORCE_SERVER_MODE=true"
set "HEYSURE_SERVER="
set "VITE_HEYSURE_SERVER="
set "HEYSURE_LAUNCH_MODE=remote"
if /i "%~1"=="--local" (
  set "HEYSURE_LOCAL_TEST=true"
  set "HEYSURE_LAUNCH_MODE=local"
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js first.
  popd >nul
  pause
  exit /b 1
)

if not exist "node_modules\electron\path.txt" (
  echo [ERROR] Electron 二进制未正确安装，请先在当前目录修复依赖：
  echo   Remove-Item -Recurse -Force node_modules\electron
  echo   $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  echo   npm install
  echo 安装完成后重新运行本脚本。
  popd >nul
  pause
  exit /b 1
)

echo ========================================
echo   AI-FREE Chromium Runtime Launcher  ^(HeySure %HEYSURE_LAUNCH_MODE%^)
echo ========================================
echo.

@call npm start
@set "EXIT_CODE=%ERRORLEVEL%"
@echo off

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Launch complete.
) else (
  echo [ERROR] Launch failed, error code: %EXIT_CODE%
)
popd >nul
exit /b %EXIT_CODE%
