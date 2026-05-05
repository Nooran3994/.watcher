@echo off
echo ========================================
echo  SCAAI Desktop v4 - Setup and Launch
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found!
    echo Please download and install Node.js from https://nodejs.org
    echo Then run this file again.
    pause
    exit /b 1
)

echo Node.js found. Installing Electron...
call npm install

echo.
echo Starting SCAAI Desktop...
call npm start
