@echo off
title AutoMate Cloud - WhatsApp Web Server
echo ===================================================
echo     Starting AutoMate Cloud Web Server...
echo ===================================================
echo.
cd /d "%~dp0web_app"
echo Opening Web App at http://localhost:3000 in your browser...
start http://localhost:3000
node server.js
pause
