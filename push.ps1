# push.ps1 — Manually deploy code to all GAS clients
# Usage: .\push.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "`n=== NBD Portal — Manual Deploy ===" -ForegroundColor Cyan

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
    Write-Host "`n--> Pushing: $($client.Name)" -ForegroundColor Yellow

    # Copy client-specific config into src/server
    Copy-Item "$($client.FullName)\ClientConfig.js" "$root\src\server\ClientConfig.js" -Force
    Copy-Item "$($client.FullName)\.clasp.json"     "$root\.clasp.json"              -Force

    # Push to GAS
    clasp push --force

    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $($client.Name)" -ForegroundColor Red
        exit 1
    }

    Write-Host "Done: $($client.Name)" -ForegroundColor Green
}

Write-Host "`n=== All clients pushed successfully! ===" -ForegroundColor Cyan
