# ─── deploy.ps1 ──────────────────────────────────────────────────────────────
# Usage:
#   .\deploy.ps1 -Client nbd-client1          # deploy one client
#   .\deploy.ps1 -All                          # deploy all clients
#
param(
  [string]$Client,
  [switch]$All
)

$ErrorActionPreference = 'Stop'
$root    = $PSScriptRoot
$clients = Join-Path $root "clients"

function Deploy-Client($clientName) {
  $dir = Join-Path $clients $clientName
  if (-not (Test-Path $dir)) {
    Write-Error "Client folder not found: $dir"
    return
  }

  Write-Host "`n==> Deploying: $clientName" -ForegroundColor Cyan

  # Swap in client-specific files
  Copy-Item "$dir\ClientConfig.js" "$root\src\server\ClientConfig.js" -Force
  Copy-Item "$dir\.clasp.json"     "$root\.clasp.json"                -Force

  # Push code to GAS
  clasp push --force
  if (-not $?) { Write-Error "clasp push failed for $clientName"; return }

  # Deploy using stored deployment ID
  $clientMeta   = Get-Content "$dir\client.json" | ConvertFrom-Json
  $deploymentId = $clientMeta.deploymentId
  $description  = $clientMeta.description

  if ($deploymentId) {
    clasp deploy --deploymentId $deploymentId --description $description
  } else {
    clasp deploy --description $description
  }

  Write-Host "==> Done: $clientName" -ForegroundColor Green
}

if ($All) {
  Get-ChildItem $clients -Directory | ForEach-Object { Deploy-Client $_.Name }
} elseif ($Client) {
  Deploy-Client $Client
} else {
  Write-Host "Usage:" -ForegroundColor Yellow
  Write-Host "  .\deploy.ps1 -Client <client-name>   Deploy a single client"
  Write-Host "  .\deploy.ps1 -All                     Deploy all clients"
  Write-Host ""
  Write-Host "Available clients:"
  Get-ChildItem $clients -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
}
