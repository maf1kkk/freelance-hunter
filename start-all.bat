@echo off
title freelance-hunter v2 - One-Click Launcher
cd /d "%~dp0"

echo =========================================
echo  freelance-hunter v2 - One-Click Launch
echo =========================================
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found!
    echo         Install from https://nodejs.org (v18+ required)
    pause
    exit /b 1
)
echo [OK] Node.js detected

REM Install npm deps if needed
if not exist "node_modules\playwright" (
    echo [INFO] Installing npm dependencies...
    npm ci >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
) else (
    echo [OK] npm dependencies present
)

REM Install Playwright browsers if needed
npx playwright install --with-deps chromium >nul 2>&1
if errorlevel 1 (
    echo [WARN] Playwright browser install had issues (continuing anyway)
) else (
    echo [OK] Playwright browsers ready
)

REM Create .env from example if missing
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo [INFO] Created .env from .env.example - edit for API keys
    )
)

echo.
echo [START] Launching services...
echo.

REM Start web server in background
start /B "" node web/server.js
timeout /t 2 /nobreak >nul

REM Start MCP server in background
start /B "" node mcp/server.js
timeout /t 1 /nobreak >nul

REM Open browser
start "" http://localhost:3410

echo.
echo =========================================
echo  All services running!
echo =========================================
echo.
echo   Web UI:  http://localhost:3410
echo   MCP:     stdio (for AI agents)
echo.
echo   Logs will appear below. Press Ctrl+C to stop.
echo =========================================
echo.

REM Keep window alive and show web server logs
node web/server.js