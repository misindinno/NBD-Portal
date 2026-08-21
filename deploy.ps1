# deploy.ps1
# Usage:
#   .\deploy.ps1 -Client nbd-client1          # deploy one client
#   .\deploy.ps1 -All                         # deploy all wired clients
#   .\deploy.ps1 -Client nbd-client1 -SkipSmoke # deploy without HTTP smoke (emergency only)
#
param(
  [string]$Client,
  [switch]$All,
  [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$clients = Join-Path $root 'clients'
$preflightScript = Join-Path $root 'scripts\deployment-preflight.ps1'
$smokeScript = Join-Path $root 'scripts\post-deployment-smoke.ps1'

function Get-DeployableClientNames {
  $names = [System.Collections.Generic.List[string]]::new()
  foreach ($clientDir in Get-ChildItem -LiteralPath $clients -Directory) {
    $required = @('.clasp.json', 'client.json', 'ClientConfig.js')
    $missing = @()
    foreach ($fileName in $required) {
      if (-not (Test-Path -LiteralPath (Join-Path $clientDir.FullName $fileName) -PathType Leaf)) {
        $missing += $fileName
      }
    }
    if ($missing.Count -gt 0) {
      Write-Host "Skipping unwired client folder '$($clientDir.Name)' (missing: $($missing -join ', '))." -ForegroundColor DarkYellow
      continue
    }
    $names.Add($clientDir.Name)
  }
  return $names.ToArray()
}

function Invoke-DeploymentPreflight([string[]]$ClientNames) {
  if (-not (Test-Path -LiteralPath $preflightScript -PathType Leaf)) {
    throw "Deployment preflight script not found: $preflightScript"
  }
  if ($ClientNames.Count -eq 0) {
    throw 'No deployable clients were selected.'
  }

  & $preflightScript -Root $root -ClientNames $ClientNames
  if ($LASTEXITCODE -ne 0) {
    throw "Deployment preflight failed with exit code $LASTEXITCODE. No clients were changed or deployed."
  }
}

function Deploy-Client([string]$ClientName) {
  $dir = Join-Path $clients $ClientName
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    throw "Client folder not found: $dir"
  }

  Write-Host "`n==> Deploying: $ClientName" -ForegroundColor Cyan

  # Swap in client-specific files after every selected client has passed preflight.
  Copy-Item -LiteralPath (Join-Path $dir 'ClientConfig.js') -Destination (Join-Path $root 'src\server\ClientConfig.js') -Force
  Copy-Item -LiteralPath (Join-Path $dir '.clasp.json') -Destination (Join-Path $root '.clasp.json') -Force

  & clasp push --force
  if ($LASTEXITCODE -ne 0) {
    throw "clasp push failed for $ClientName (exit code $LASTEXITCODE)"
  }

  $clientMeta = Get-Content -LiteralPath (Join-Path $dir 'client.json') -Raw | ConvertFrom-Json
  $deploymentId = [string]$clientMeta.deploymentId
  $description = [string]$clientMeta.description

  if (-not [string]::IsNullOrWhiteSpace($deploymentId)) {
    & clasp deploy --deploymentId $deploymentId --description $description
  } else {
    & clasp deploy --description $description
  }
  if ($LASTEXITCODE -ne 0) {
    throw "clasp deploy failed for $ClientName (exit code $LASTEXITCODE)"
  }

  if (-not $SkipSmoke) {
    if ([string]::IsNullOrWhiteSpace($deploymentId)) {
      Write-Warning "Skipping post-deployment smoke for $ClientName because the new deployment ID is not available in client.json."
    } elseif (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) {
      throw "Post-deployment smoke script not found: $smokeScript"
    } else {
      & $smokeScript -DeploymentId $deploymentId -ClientName $ClientName
      if ($LASTEXITCODE -ne 0) {
        throw "Post-deployment smoke failed for $ClientName (exit code $LASTEXITCODE)"
      }
    }
  }

  Write-Host "==> Done: $ClientName" -ForegroundColor Green
}

if ($All) {
  $selectedClients = @(Get-DeployableClientNames)
  Invoke-DeploymentPreflight $selectedClients
  foreach ($clientName in $selectedClients) {
    Deploy-Client $clientName
  }
} elseif (-not [string]::IsNullOrWhiteSpace($Client)) {
  $selectedClients = @($Client)
  Invoke-DeploymentPreflight $selectedClients
  Deploy-Client $Client
} else {
  Write-Host 'Usage:' -ForegroundColor Yellow
  Write-Host '  .\deploy.ps1 -Client <client-name>   Deploy a single client'
  Write-Host '  .\deploy.ps1 -All                    Deploy all wired clients'
  Write-Host '  .\deploy.ps1 -Client <name> -SkipSmoke  Skip post-deploy smoke (emergency only)'
  Write-Host ''
  Write-Host 'Available clients:'
  Get-ChildItem -LiteralPath $clients -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
}
