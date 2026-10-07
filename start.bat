@echo off
title minimax-code-proxy
cd /d "%~dp0"
where node >nul 2>nul || (
  echo [error] node not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)
node proxy.mjs
echo.
echo [proxy stopped] press any key to close
pause >nul
