<# 
.SYNOPSIS
    One-click launcher for freelance-hunter v2
    Checks dependencies, installs if needed, starts all services
#>

param(
    [switch]$NoBrowser,
    [switch]$SkipInstall,
    [switch]$OnlyWeb,
    [switch]$OnlyMcp,
    [int]$Port = 3410
)

$ErrorActionPreference = "Stop"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $PROJECT_ROOT

function Write-Header { param([string]$msg) Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err { param([string]$msg) Write-Host "  [ERROR] $msg" -ForegroundColor Red }
function Write-Info { param([string]$msg) Write-Host "  [INFO] $msg" -ForegroundColor Gray }

Write-Header "freelance-hunter v2 - One-Click Launcher"

# Check Node.js
Write-Header "Checking Node.js"
$nodeVer = node --version 2>$null
if (-not $nodeVer) {
    Write-Err "Node.js not found. Install from https://nodejs.org (v18+ required)"
    exit 1
}
Write-Ok "Node.js $nodeVer"

# Check npm packages
Write-Header "Checking npm dependencies"
if (-not (Test-Path "node_modules/playwright")) {
    if ($SkipInstall) {
        Write-Warn "playwright not installed, skipping (--SkipInstall)"
    } else {
        Write-Info "Installing npm dependencies..."
        npm ci 2>&1 | Out-Null
        Write-Ok "npm dependencies installed"
    }
} else {
    Write-Ok "npm dependencies present"
}

# Check Playwright browsers
Write-Header "Checking Playwright browsers"
$browsers = @("chromium", "firefox", "webkit")
$missing = @()
foreach ($b in $browsers) {
    $path = "$env:USERPROFILE\AppData\Local\ms-playwright\$b-*"
    if (-not (Get-Item $path -ErrorAction SilentlyContinue)) {
        $missing += $b
    }
}
if ($missing.Count -gt 0) {
    if ($SkipInstall) {
        Write-Warn "Playwright browsers missing: $($missing -join ', ')"
    } else {
        Write-Info "Installing Playwright browsers: $($missing -join ', ') (timeout 60s each)"
        $installed = $true
        foreach ($b in $missing) {
            $proc = Start-Process npx -ArgumentList "playwright install $b" -Wait -PassThru -NoNewWindow
            if ($proc.ExitCode -ne 0) {
                Write-Warn "Failed to install $b (exit code $($proc.ExitCode)) - continuing anyway"
                $installed = $false
            }
        }
        if ($installed) { Write-Ok "Playwright browsers installed" }
    }
} else {
    Write-Ok "Playwright browsers present"
}

# Check Python for Telegram (optional)
Write-Header "Checking Python (Telegram source)"
$py = $null
if (Get-Command python -ErrorAction SilentlyContinue) { $py = "python" }
elseif (Get-Command python3 -ErrorAction SilentlyContinue) { $py = "python3" }
elseif (Get-Command py -ErrorAction SilentlyContinue) { $py = "py" }

if ($py) {
    Write-Ok "Python found: $py"
    & $py -c "import telethon" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "telethon available"
    } else {
        Write-Warn "telethon not installed (Telegram source will be limited)"
    }
} else {
    Write-Warn "Python not found (Telegram source disabled)"
}

# Check .env for secrets
Write-Header "Checking configuration"
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Warn "Created .env from .env.example - edit it for API keys"
    } else {
        Write-Warn "No .env or .env.example found"
    }
} else {
    Write-Ok ".env exists"
}

# Check database
Write-Header "Checking database"
if (-not (Test-Path "data/store.db")) {
    Write-Info "Database not found - will be created on first poll"
} else {
    Write-Ok "Database exists"
}

# Function to start a service
$processes = @()
function Start-Service {
 param([string]$Name, [string]$Script, [string[]]$ArgList = @(), [int]$WaitMs = 1000)
 $psi = New-Object System.Diagnostics.ProcessStartInfo
 $psi.FileName = "node"
 $psi.Arguments = "$Script " + ($ArgList -join " ")
 $psi.WorkingDirectory = $PROJECT_ROOT
 $psi.WindowStyle = "Hidden"
 $psi.UseShellExecute = $false
 $psi.CreateNoWindow = $true
 $psi.RedirectStandardOutput = $true
 $psi.RedirectStandardError = $true
 $proc = [System.Diagnostics.Process]::Start($psi)
 $processes += @{ Name = $Name; Process = $proc }
 Start-Sleep -Milliseconds $WaitMs
 if (-not $proc.HasExited) {
 Write-Ok "$Name started (PID $($proc.Id))"
 return $true
 } else {
 $err = $proc.StandardError.ReadToEnd()
 Write-Err "$Name failed to start: $err"
 return $false
 }
}

# Cleanup on exit
$cleanup = {
 Write-Host "`nShutting down services..." -ForegroundColor Yellow
 foreach ($p in $processes) {
 if (-not $p.Process.HasExited) {
 try { $p.Process.Kill() } catch {}
 }
 }
 exit 0
}

# Register cleanup
Register-EngineEvent -SourceIdentifier "PowerShell.Exiting" -Action $cleanup | Out-Null
try { [Console]::CancelKeyPress += { & $cleanup } } catch {}

# Start services
Write-Header "Starting services"

if (-not $OnlyMcp) {
 # Kill any existing process on port
 $existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
 if ($existing) {
 Write-Warn "Port $Port in use (PID $existing) - stopping existing process"
 try { Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue } catch {}
 Start-Sleep -Milliseconds 500
 }
 Start-Service "Web UI" "web/server.js" @("--port", "$Port") 2000
 if (-not $NoBrowser) {
 Start-Sleep -Milliseconds 500
 try { Start-Process "http://localhost:$Port" } catch {}
 }
}

Write-Header "All services running"
Write-Host " Web UI: http://localhost:$Port" -ForegroundColor Cyan
Write-Host "`nPress Ctrl+C to stop" -ForegroundColor Gray

# Keep alive
try {
 while ($true) {
 Start-Sleep -Seconds 2
 $dead = $processes | Where-Object { $_.Process.HasExited }
 if ($dead) {
 foreach ($d in $dead) {
 Write-Err "$($d.Name) stopped (exit code $($d.Process.ExitCode))"
 }
 break
 }
 }
} finally {
 & $cleanup
}