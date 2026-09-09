[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$DeploymentId,

  [string]$ClientName = 'portal',

  [ValidateRange(1, 12)]
  [int]$Attempts = 6,

  [ValidateRange(1, 30)]
  [int]$DelaySeconds = 5
)

$ErrorActionPreference = 'Stop'
$url = "https://script.google.com/macros/s/$DeploymentId/exec"
$failures = [System.Collections.Generic.List[string]]::new()

for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 8 -TimeoutSec 45
    $body = [string]$response.Content
    $status = [int]$response.StatusCode
    $hasShell = ($body -match 'app-shell') -and ($body -match 'renderSidebar')
    $hasDiagnostics = $body -match 'PortalDiagnostics'
    $hasFsrHistory = ($body -match 'data-fsr-history-tab') -and ($body -match '_mountFsrVisitHistory') -and ($body -match 'apiGetFsrVisitHistory')
    $hasTitle = $body -match '<title>[^<]+</title>'

    if ($status -eq 200 -and $hasShell -and $hasDiagnostics -and $hasTitle -and $hasFsrHistory) {
      Write-Host "==> Smoke passed: $ClientName (HTTP $status, $($body.Length) bytes)" -ForegroundColor Green
      return
    }

    $failures.Add("attempt=$attempt status=$status bytes=$($body.Length) shell=$hasShell diagnostics=$hasDiagnostics title=$hasTitle fsrHistory=$hasFsrHistory")
  } catch {
    $failures.Add("attempt=$attempt error=$($_.Exception.Message)")
  }

  if ($attempt -lt $Attempts) {
    Start-Sleep -Seconds $DelaySeconds
  }
}

$summary = $failures -join [Environment]::NewLine
throw "Post-deployment smoke failed for '$ClientName' after $Attempts attempts. URL path: /macros/s/<redacted>/exec`n$summary"
