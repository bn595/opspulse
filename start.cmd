@echo off
rem Double-click to start opspulse. Requires Node.js 18+ on PATH.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
node src\server.js %*
if errorlevel 1 pause
