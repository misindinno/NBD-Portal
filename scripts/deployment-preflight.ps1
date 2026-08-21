[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Root,

  [Parameter(Mandatory = $true)]
  [string[]]$ClientNames
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$srcPath = Join-Path $rootPath 'src'
$clientsPath = Join-Path $rootPath 'clients'
$syntaxScript = Join-Path $rootPath 'scripts\check-syntax.js'
$contractTests = @(
  (Join-Path $rootPath 'tests\architecture-pagination.contract.test.js'),
  (Join-Path $rootPath 'tests\server-security-surface.contract.test.js'),
  (Join-Path $rootPath 'tests\debug-architecture.contract.test.js')
)
$browserProbe = Join-Path $rootPath 'scripts\browser-portal-debug.js'
$postDeploySmoke = Join-Path $rootPath 'scripts\post-deployment-smoke.ps1'
$errors = [System.Collections.Generic.List[string]]::new()

function Add-PreflightError([string]$Message) {
  $errors.Add($Message)
}

function Read-JsonFile([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-PreflightError "$Label is missing: $Path"
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    Add-PreflightError "$Label is invalid JSON: $Path ($($_.Exception.Message))"
    return $null
  }
}

function Assert-NonEmptyJsonProperty($Json, [string]$Property, [string]$Label) {
  if ($null -eq $Json) { return }
  $value = $Json.PSObject.Properties[$Property].Value
  if ([string]::IsNullOrWhiteSpace([string]$value)) {
    Add-PreflightError "$Label must define a non-empty '$Property'."
  }
}

function Assert-ClientConfig([string]$Path, [string]$ClientName) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-PreflightError "Client '$ClientName' is missing ClientConfig.js."
    return
  }

  $source = Get-Content -LiteralPath $Path -Raw
  if (Get-Command node -ErrorAction SilentlyContinue) {
    & node --check $Path
    if ($LASTEXITCODE -ne 0) {
      Add-PreflightError "Client '$ClientName' ClientConfig.js has invalid JavaScript syntax."
    }
  }
  if ($source -notmatch '(?m)^\s*const\s+CLIENT_CONFIG\s*=\s*\{') {
    Add-PreflightError "Client '$ClientName' ClientConfig.js must declare const CLIENT_CONFIG."
  }

  $requiredConfig = @(
    'SPREADSHEET_ID',
    'USER_DATABASE_SPREADSHEET_ID',
    'USER_DATABASE_SHEET_NAME',
    'PORTAL_KEY',
    'APP_TITLE',
    'UPLOAD_FOLDER_NAME'
  )
  foreach ($key in $requiredConfig) {
    $pattern = '(?m)^\s*' + [regex]::Escape($key) + '\s*:\s*([\x27\x22])(?<value>.*?)\1\s*,'
    $match = [regex]::Match($source, $pattern)
    if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups['value'].Value)) {
      Add-PreflightError "Client '$ClientName' ClientConfig.js must define non-empty $key."
    }
  }

  $requiredTheme = @(
    'LO_ACC', 'LO_ACC_H', 'LO_ACC2', 'LO_SOFT',
    'LO_GLOW_1', 'LO_GLOW_2', 'LO_GLOW_3', 'LO_MARK_SHADOW'
  )
  foreach ($key in $requiredTheme) {
    $pattern = '(?m)^\s*' + [regex]::Escape($key) + '\s*:\s*([\x27\x22])(?<value>.*?)\1\s*,'
    $match = [regex]::Match($source, $pattern)
    if (-not $match.Success -or [string]::IsNullOrWhiteSpace($match.Groups['value'].Value)) {
      Add-PreflightError "Client '$ClientName' ClientConfig.js theme must define non-empty $key."
    }
  }
}

Write-Host "`n==> Running local deployment preflight" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $srcPath -PathType Container)) {
  Add-PreflightError "Apps Script source directory is missing: $srcPath"
}
if (-not (Test-Path -LiteralPath $syntaxScript -PathType Leaf)) {
  Add-PreflightError "Syntax checker is missing: $syntaxScript"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Add-PreflightError 'Node.js is required to run scripts/check-syntax.js.'
}
if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  Add-PreflightError 'clasp was not found. Install it with: npm install -g @google/clasp'
}

$manifest = Read-JsonFile (Join-Path $srcPath 'appsscript.json') 'Apps Script manifest'
if ($null -ne $manifest) {
  if ([string]$manifest.runtimeVersion -ne 'V8') {
    Add-PreflightError "src/appsscript.json must use runtimeVersion 'V8'."
  }
  if ($null -eq $manifest.webapp) {
    Add-PreflightError 'src/appsscript.json must define webapp deployment settings.'
  }
}

foreach ($requiredPath in @(
  (Join-Path $srcPath 'Index.html'),
  (Join-Path $srcPath 'Diagnostics.html'),
  (Join-Path $srcPath 'server\Code.js'),
  (Join-Path $srcPath 'server\DebugService.js'),
  $browserProbe,
  $postDeploySmoke
)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    Add-PreflightError "Required Apps Script source file is missing: $requiredPath"
  }
}

if (Test-Path -LiteralPath $srcPath -PathType Container) {
  $sourceFiles = @(Get-ChildItem -LiteralPath $srcPath -Recurse -File | Where-Object { $_.Extension -in @('.js', '.html', '.json') })
  if ($sourceFiles.Count -eq 0) {
    Add-PreflightError 'No deployable .js, .html, or .json files were found under src.'
  }
  foreach ($file in $sourceFiles) {
    $content = Get-Content -LiteralPath $file.FullName -Raw
    if ($content -match '(?m)^(<<<<<<<|=======|>>>>>>>)') {
      Add-PreflightError "Unresolved merge conflict marker found in $($file.FullName)."
    }
  }

  $htmlFiles = @(Get-ChildItem -LiteralPath $srcPath -File -Filter '*.html')
  $htmlNames = @{}
  foreach ($file in $htmlFiles) { $htmlNames[$file.BaseName.ToLowerInvariant()] = $file.BaseName }
  foreach ($file in $htmlFiles) {
    $content = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($match in [regex]::Matches($content, "include\(\s*['\x22](?<name>[^'\x22]+)['\x22]\s*\)")) {
      $includeName = $match.Groups['name'].Value
      if (-not $htmlNames.ContainsKey($includeName.ToLowerInvariant())) {
        Add-PreflightError "Missing HTML include '$includeName' referenced by $($file.Name)."
      }
    }
  }
}

$seenScriptIds = @{}
foreach ($clientName in $ClientNames) {
  $clientPath = Join-Path $clientsPath $clientName
  if (-not (Test-Path -LiteralPath $clientPath -PathType Container)) {
    Add-PreflightError "Client folder not found: $clientPath"
    continue
  }

  $claspConfig = Read-JsonFile (Join-Path $clientPath '.clasp.json') "Client '$clientName' .clasp.json"
  $clientMeta = Read-JsonFile (Join-Path $clientPath 'client.json') "Client '$clientName' client.json"
  Assert-NonEmptyJsonProperty $claspConfig 'scriptId' "Client '$clientName' .clasp.json"
  Assert-NonEmptyJsonProperty $claspConfig 'rootDir' "Client '$clientName' .clasp.json"
  Assert-NonEmptyJsonProperty $clientMeta 'description' "Client '$clientName' client.json"
  Assert-ClientConfig (Join-Path $clientPath 'ClientConfig.js') $clientName

  if ($null -ne $claspConfig) {
    $configuredRoot = [string]$claspConfig.rootDir
    if ($configuredRoot -notin @('./src', '.\src', 'src')) {
      Add-PreflightError "Client '$clientName' .clasp.json rootDir must point to ./src (found '$configuredRoot')."
    }
    $scriptId = [string]$claspConfig.scriptId
    if (-not [string]::IsNullOrWhiteSpace($scriptId)) {
      if ($seenScriptIds.ContainsKey($scriptId)) {
        Add-PreflightError "Clients '$($seenScriptIds[$scriptId])' and '$clientName' share scriptId '$scriptId'."
      } else {
        $seenScriptIds[$scriptId] = $clientName
      }
    }
  }
}

if ($errors.Count -eq 0) {
  & node $syntaxScript
  if ($LASTEXITCODE -ne 0) {
    Add-PreflightError "JavaScript/HTML syntax validation failed with exit code $LASTEXITCODE."
  }

  & node --check $browserProbe
  if ($LASTEXITCODE -ne 0) {
    Add-PreflightError "Emergency browser probe syntax validation failed with exit code $LASTEXITCODE."
  }

  foreach ($contractTest in $contractTests) {
    if (-not (Test-Path -LiteralPath $contractTest -PathType Leaf)) {
      Add-PreflightError "Contract test is missing: $contractTest"
      continue
    }
    & node $contractTest
    if ($LASTEXITCODE -ne 0) {
      Add-PreflightError "Contract test failed: $contractTest (exit code $LASTEXITCODE)."
    }
  }
}

if ($errors.Count -gt 0) {
  Write-Host "`nDeployment preflight failed:" -ForegroundColor Red
  foreach ($errorMessage in $errors) {
    Write-Host "  - $errorMessage" -ForegroundColor Red
  }
  exit 1
}

Write-Host "==> Preflight passed for $($ClientNames.Count) client(s)." -ForegroundColor Green
exit 0

