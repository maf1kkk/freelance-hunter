@echo off
title Freelance Hunter
chcp 65001 >nul
echo.
echo  ==========================================
echo   freelance-hunter v2 - zapusk sayta
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js ne nayden. Ustanovi s https://nodejs.org
    pause
    exit /b 1
)

cd /d "%~dp0"

if not exist "node_modules" (
    echo [INFO] Pervyy zapusk - ustanavlivayu zavisimosti...
    call npm install
    echo.
)

echo [OK] Server: http://localhost:3410
echo  Okno mozhno svernut - server rabotaet poka ono otkryto.
echo  Ostanovka: zakroy eto okno ili Ctrl+C
echo.

start "" http://localhost:3410
node web/server.js
pause