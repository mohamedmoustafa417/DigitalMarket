# ═══════════════════════════════════════════════════════════════════
# DigitalMarket One-Click Deploy
# ═══════════════════════════════════════════════════════════════════
# Usage: Right-click this file -> Run with PowerShell
# (Or in PowerShell:  cd C:\Users\LapTop\Downloads\Claude\deploy ; .\DEPLOY.ps1)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  DigitalMarket - Firebase Deploy" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Node.js
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js not installed." -ForegroundColor Red
    Write-Host "  Install from: https://nodejs.org/  (LTS version)" -ForegroundColor White
    Write-Host "  Then re-run this script." -ForegroundColor White
    exit 1
}
Write-Host "  OK: $(node --version)" -ForegroundColor Green

# Step 2: Check / install Firebase CLI
Write-Host "[2/5] Checking Firebase CLI..." -ForegroundColor Yellow
$fb = Get-Command firebase -ErrorAction SilentlyContinue
if (-not $fb) {
    Write-Host "  Installing Firebase CLI (npm install -g firebase-tools)..." -ForegroundColor White
    npm install -g firebase-tools
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Install failed. Try running PowerShell as Administrator." -ForegroundColor Red
        exit 1
    }
}
Write-Host "  OK: $(firebase --version)" -ForegroundColor Green

# Step 3: Check login
Write-Host "[3/5] Checking Firebase login..." -ForegroundColor Yellow
$loginCheck = firebase projects:list 2>&1
if ($LASTEXITCODE -ne 0 -or $loginCheck -match 'Error') {
    Write-Host "  Not logged in. Opening browser..." -ForegroundColor White
    firebase login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Login failed." -ForegroundColor Red
        exit 1
    }
}
Write-Host "  OK: Logged in" -ForegroundColor Green

# Step 4: Install function dependencies
Write-Host "[4/5] Installing Cloud Function dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "functions\node_modules")) {
    Push-Location functions
    npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  npm install failed in functions folder." -ForegroundColor Red
        exit 1
    }
}
Write-Host "  OK: Dependencies ready" -ForegroundColor Green

# Step 5: Deploy
Write-Host "[5/5] Deploying to Firebase..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Deploying: Firestore rules + indexes + Storage rules + Cloud Functions" -ForegroundColor White
Write-Host "  (Hosting is on GitHub Pages - skipping)" -ForegroundColor DarkGray
Write-Host ""

firebase deploy --only firestore:rules,firestore:indexes,storage,functions

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Green
    Write-Host "  Deploy SUCCESS" -ForegroundColor Green
    Write-Host "==================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next manual steps (Firebase Console - browser only):" -ForegroundColor Yellow
    Write-Host "  1. Enable Phone Auth: https://console.firebase.google.com/project/digitalmarket-38db5/authentication/providers" -ForegroundColor White
    Write-Host "  2. Enable MFA (requires Blaze plan):" -ForegroundColor White
    Write-Host "     https://console.firebase.google.com/project/digitalmarket-38db5/authentication/settings" -ForegroundColor White
    Write-Host "  3. (Optional) Get Microsoft Clarity ID: https://clarity.microsoft.com" -ForegroundColor White
    Write-Host "  4. (Optional) Get Tawk.to chat ID:    https://www.tawk.to" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "Deploy FAILED. Common issues:" -ForegroundColor Red
    Write-Host "  - Cloud Functions require Blaze (pay-as-you-go) plan" -ForegroundColor Yellow
    Write-Host "    Upgrade: https://console.firebase.google.com/project/digitalmarket-38db5/usage/details" -ForegroundColor White
    Write-Host "  - Firestore indexes may take a few minutes to build" -ForegroundColor Yellow
    Write-Host ""
}

Read-Host "Press Enter to close"
