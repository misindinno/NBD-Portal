# push.ps1 - Manually deploy code to all GAS clients
# Usage: .\push.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host ""
Write-Host "=== NBD Portal - Manual Deploy ===" -ForegroundColor Cyan

# Check clasp is installed
if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: clasp not found. Run: npm install -g @google/clasp" -ForegroundColor Red
    exit 1
}

$clients = Get-ChildItem "$root\clients" -Directory

if ($clients.Count -eq 0) {
    Write-Host "ERROR: No clients found in .\clients\" -ForegroundColor Red
    exit 1
}

foreach ($client in $clients) {
    Write-Host ""
    Write-Host "--> Pushing: $($client.Name)" -ForegroundColor Yellow

    $claspPath = Join-Path $client.FullName ".clasp.json"
    if (-not (Test-Path $claspPath)) {
        Write-Host "SKIP: $($client.Name) — no .clasp.json (not yet wired up)" -ForegroundColor DarkYellow
        continue
    }
    try {
        $claspJson = Get-Content $claspPath -Raw | ConvertFrom-Json
    } catch {
        Write-Host "SKIP: $($client.Name) — invalid .clasp.json" -ForegroundColor DarkYellow
        continue
    }
    if (-not $claspJson.scriptId) {
        Write-Host "SKIP: $($client.Name) — scriptId not configured (see SETUP.md if present)" -ForegroundColor DarkYellow
        continue
    }

    Copy-Item "$($client.FullName)\ClientConfig.js" "$root\src\server\ClientConfig.js" -Force
    Copy-Item $claspPath "$root\.clasp.json" -Force

    clasp push --force

    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $($client.Name)" -ForegroundColor Red
        exit 1
    }

    Write-Host "Done: $($client.Name)" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== All clients pushed successfully ===" -ForegroundColor Cyan
