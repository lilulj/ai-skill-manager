@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 AI Skill Manager...
npx electron .
if errorlevel 1 pause
