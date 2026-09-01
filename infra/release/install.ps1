#Requires -Version 5.1
<#
.SYNOPSIS
  Install or update Step Harness on Windows.

.DESCRIPTION
  This is the Windows counterpart to infra/release/install.sh.  Release
  manifests are authoritative for the package URL and checksum; the installer
  only knows how to select the current Windows architecture and lay out the
  files expected by the Step runtime.

.PARAMETER Version
  A release version (vX.Y.Z, step-vX.Y.Z, refs/tags/vX.Y.Z) or latest.

.PARAMETER InstallDir
  Directory containing step.exe. Defaults to STEP_INSTALL_DIR or
  %USERPROFILE%\.step-harness\bin.

.PARAMETER AgentDir
  Step agent data directory. Managed fd/rg binaries are placed in its bin
  subdirectory. Defaults to STEP_HARNESS_CODING_AGENT_DIR, the legacy
  STEP_CODING_AGENT_DIR alias, or %USERPROFILE%\.step-harness\agent.
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$InstallDir,
  [string]$AgentDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$HomeDir = if ($env:USERPROFILE) {
  $env:USERPROFILE
} else {
  [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
}

$BaseUrl = if ($env:STEP_RELEASE_BASE_URL) {
  $env:STEP_RELEASE_BASE_URL
} else {
  '__STEP_RELEASE_BASE_URL__'
}
$BaseUrl = $BaseUrl.TrimEnd('/')

if (-not $Version) {
  $Version = if ($env:STEP_VERSION) { $env:STEP_VERSION } else { 'latest' }
}
if (-not $InstallDir) {
  $InstallDir = if ($env:STEP_INSTALL_DIR) {
    $env:STEP_INSTALL_DIR
  } else {
    Join-Path $HomeDir '.step-harness\bin'
  }
}
if (-not $AgentDir) {
  $AgentDir = if ($env:STEP_HARNESS_CODING_AGENT_DIR) {
    $env:STEP_HARNESS_CODING_AGENT_DIR
  } elseif ($env:STEP_CODING_AGENT_DIR) {
    $env:STEP_CODING_AGENT_DIR
  } else {
    Join-Path $HomeDir '.step-harness\agent'
  }
}

$InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
$AgentDir = [Environment]::ExpandEnvironmentVariables($AgentDir)

function Write-Log {
  param([string]$Message)
  Write-Host "  $Message" -ForegroundColor DarkGray
}

function Write-Progress-Step {
  param([int]$Step, [int]$Total, [string]$Message)
  Write-Host "  [$Step/$Total] $Message" -ForegroundColor DarkGray
}

function Stop-WithError {
  param([string]$Message)
  throw $Message
}

function Get-ObjectProperty {
  param(
    [AllowNull()]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Normalize-Version {
  param([Parameter(Mandatory = $true)][string]$InputVersion)
  $normalized = $InputVersion.Trim()
  $normalized = $normalized -replace '^refs/tags/', ''
  $normalized = $normalized -replace '^step-v', ''
  $normalized = $normalized -replace '^v', ''
  if ($normalized -notmatch '^\d+\.\d+\.\d+$') {
    Stop-WithError "invalid release version '$InputVersion' (expected vX.Y.Z or latest)"
  }
  return $normalized
}

function Get-TargetId {
  # PROCESSOR_ARCHITEW6432 describes the native host when 32-bit PowerShell is
  # running under WOW64. Prefer it so an ARM64 host does not receive an x86
  # package merely because the shell is 32-bit.
  $arch = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } else {
    $env:PROCESSOR_ARCHITECTURE
  }
  if (-not $arch) {
    Stop-WithError 'could not detect the Windows processor architecture'
  }
  switch ($arch.ToUpperInvariant()) {
    'AMD64' { return 'windows-x64' }
    'ARM64' { return 'windows-arm64' }
    default { Stop-WithError "unsupported Windows architecture '$arch' (supported: AMD64, ARM64)" }
  }
}

function Get-Manifest {
  param([Parameter(Mandatory = $true)][string]$ManifestUrl)
  try {
    return Invoke-RestMethod -Uri $ManifestUrl -Headers @{ 'User-Agent' = 'step-harness-installer' } -UseBasicParsing
  } catch {
    Stop-WithError "failed to fetch release manifest $ManifestUrl ($($_.Exception.Message))"
  }
}

function Get-PackageUrl {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$TargetId
  )
  $packages = Get-ObjectProperty -Object $Manifest -Name 'packages'
  $entry = Get-ObjectProperty -Object $packages -Name $TargetId
  if (-not $entry) {
    Stop-WithError "release manifest does not contain package for $TargetId"
  }
  return [string]$entry
}

function Get-PackageChecksum {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$TargetId
  )
  $checksums = Get-ObjectProperty -Object $Manifest -Name 'checksums'
  $entry = Get-ObjectProperty -Object $checksums -Name $TargetId
  if ($entry) {
    return [string]$entry
  }
  return $null
}

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -Headers @{ 'User-Agent' = 'step-harness-installer' } -UseBasicParsing
  } catch {
    Stop-WithError "failed to download $Url ($($_.Exception.Message))"
  }
}

function Test-ArchiveChecksum {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [AllowEmptyString()][string]$ExpectedSha256
  )
  if (-not $ExpectedSha256) {
    Write-Log 'manifest has no checksum for this target; skipped verification'
    return
  }
  $actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $expected = $ExpectedSha256.Trim().ToLowerInvariant()
  if ($actual -ne $expected) {
    Stop-WithError "checksum mismatch (expected $expected, got $actual)"
  }
}

function Move-RunningBinaryAside {
  param([Parameter(Mandatory = $true)][string]$BinaryPath)
  $asidePath = "$BinaryPath.old"
  Remove-Item -LiteralPath $asidePath -Force -ErrorAction SilentlyContinue
  try {
    # A running Windows executable cannot be overwritten, but it can be
    # renamed. The self-update path relies on this replacement behavior.
    Move-Item -LiteralPath $BinaryPath -Destination $asidePath -Force -ErrorAction Stop | Out-Null
  } catch {
    Stop-WithError "could not move the existing step.exe aside: $($_.Exception.Message). Close running Step processes and retry"
  }
  return $asidePath
}

function Copy-FileWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $lastError = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop | Out-Null
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
  $detail = if ($lastError) { $lastError.Exception.Message } else { 'unknown error' }
  Stop-WithError "could not write $Destination after 5 attempts: $detail"
}

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    return
  }
  $asidePath = "$Destination.old.$PID"
  if (Test-Path -LiteralPath $asidePath) {
    Remove-Item -LiteralPath $asidePath -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $Destination) {
    try {
      # Rename is allowed for a directory containing a loaded .node on Windows;
      # deleting/overwriting that file is not. This keeps self-update usable
      # while the old process is finishing its shutdown.
      Move-Item -LiteralPath $Destination -Destination $asidePath -Force -ErrorAction Stop | Out-Null
    } catch {
      Write-Log "warning: could not move old runtime directory $Destination aside; attempting in-place update"
      $asidePath = $null
    }
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  try {
    foreach ($entry in @(Get-ChildItem -LiteralPath $Source -Force)) {
      Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $Destination $entry.Name) -Recurse -Force | Out-Null
    }
  } finally {
    if ($asidePath) {
      Remove-Item -LiteralPath $asidePath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Install-Package {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ExtractDir,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  New-Item -ItemType Directory -Path $ExtractDir, $Destination -Force | Out-Null
  try {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractDir -Force
  } catch {
    Stop-WithError "could not extract the release archive ($($_.Exception.Message))"
  }

  $binary = Join-Path $ExtractDir 'step.exe'
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    Stop-WithError 'release archive does not contain step.exe'
  }

  $target = Join-Path $Destination 'step.exe'
  $asidePath = $null
  if (Test-Path -LiteralPath $target -PathType Leaf) {
    $asidePath = Move-RunningBinaryAside -BinaryPath $target
  }
  Copy-FileWithRetry -Source $binary -Destination $target
  if ($asidePath) {
    Remove-Item -LiteralPath $asidePath -Force -ErrorAction SilentlyContinue
  }

  # Keep the runtime files shipped by build-binaries.sh in sync. In particular,
  # native contains pi-tui's console-mode helper and node_modules contains the
  # platform clipboard binding loaded by the compiled executable.
  foreach ($directory in @('native', 'theme', 'assets', 'export-html', 'docs', 'examples', 'node_modules')) {
    $sourceDir = Join-Path $ExtractDir $directory
    $targetDir = Join-Path $Destination $directory
    if (Test-Path -LiteralPath $sourceDir -PathType Container) {
      Copy-DirectoryContents -Source $sourceDir -Destination $targetDir
    }
  }
  foreach ($fileName in @('package.json', 'README.md', 'CHANGELOG.md', 'photon_rs_bg.wasm')) {
    $sourceFile = Join-Path $ExtractDir $fileName
    if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
      Copy-FileWithRetry -Source $sourceFile -Destination (Join-Path $Destination $fileName)
    }
  }
}

function Test-CommandAvailable {
  param([Parameter(Mandatory = $true)][string[]]$Names)
  foreach ($name in $Names) {
    if (Get-Command -Name $name -ErrorAction SilentlyContinue) {
      return $true
    }
  }
  return $false
}

function Install-ManagedTool {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$TargetId,
    [Parameter(Mandatory = $true)][string]$WorkDir
  )

  $toolDir = Join-Path $AgentDir 'bin'
  $binaryName = "$Name.exe"
  $destination = Join-Path $toolDir $binaryName
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    return
  }
  $systemNames = if ($Name -eq 'fd') { @('fd.exe', 'fd', 'fdfind.exe', 'fdfind') } else { @('rg.exe', 'rg') }
  if (Test-CommandAvailable -Names $systemNames) {
    return
  }

  try {
    $metadataUrl = "https://api.github.com/repos/$Repository/releases/latest"
    $metadata = Invoke-RestMethod -Uri $metadataUrl -Headers @{ 'User-Agent' = 'step-harness-installer'; Accept = 'application/vnd.github+json' } -UseBasicParsing
    $tag = [string](Get-ObjectProperty -Object $metadata -Name 'tag_name')
    if (-not $tag) {
      throw "GitHub release metadata did not contain tag_name"
    }
    $version = $tag -replace '^v', ''
    $archName = if ($TargetId -eq 'windows-arm64') { 'aarch64' } else { 'x86_64' }
    $assetName = if ($Name -eq 'fd') {
      "fd-v$version-${archName}-pc-windows-msvc.zip"
    } else {
      "ripgrep-$version-${archName}-pc-windows-msvc.zip"
    }
    $archivePath = Join-Path $WorkDir "$Name.zip"
    $extractPath = Join-Path $WorkDir "$Name-extract"
    New-Item -ItemType Directory -Path $extractPath, $toolDir -Force | Out-Null
    Invoke-Download -Url "https://github.com/$Repository/releases/download/$tag/$assetName" -Destination $archivePath
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
    $found = @(Get-ChildItem -LiteralPath $extractPath -Recurse -File -Filter $binaryName | Select-Object -First 1)
    if ($found.Count -eq 0) {
      throw "archive did not contain $binaryName"
    }
    Copy-FileWithRetry -Source $found[0].FullName -Destination $destination
  } catch {
    # fd/rg are convenience dependencies. A system installation or a later
    # migration can still provide them, so a failed optional download must not
    # make the main Step installation fail.
    Write-Log "warning: could not install $Name ($($_.Exception.Message)); install it manually if needed"
  }
}

function Install-ManagedTools {
  param(
    [Parameter(Mandatory = $true)][string]$TargetId,
    [Parameter(Mandatory = $true)][string]$WorkDir
  )
  New-Item -ItemType Directory -Path (Join-Path $AgentDir 'bin') -Force | Out-Null
  Install-ManagedTool -Name 'fd' -Repository 'sharkdp/fd' -TargetId $TargetId -WorkDir $WorkDir
  Install-ManagedTool -Name 'rg' -Repository 'BurntSushi/ripgrep' -TargetId $TargetId -WorkDir $WorkDir
}

function Test-Install {
  param([Parameter(Mandatory = $true)][string]$BinaryPath)
  & $BinaryPath --version *> $null
  if ($LASTEXITCODE -ne 0) {
    Stop-WithError 'installed step failed smoke test'
  }
}

function Write-Result {
  param([Parameter(Mandatory = $true)][string]$ResolvedVersion)
  $binaryPath = Join-Path $InstallDir 'step.exe'
  Write-Host "  installed step-harness $ResolvedVersion to $binaryPath" -ForegroundColor Green
  $pathEntries = @($env:PATH -split ';' | Where-Object { $_ })
  $managedBin = Join-Path $AgentDir 'bin'
  $missing = @($InstallDir, $managedBin) | Where-Object { $pathEntries -notcontains $_ }
  if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Log 'note: add these directories to PATH for future sessions:'
    foreach ($entry in $missing) {
      Write-Host "  $entry"
    }
    Write-Log 'for the current PowerShell session:'
    $pathCommand = '  $env:PATH = "' + (($missing -join ';') + ';$env:PATH"')
    Write-Host $pathCommand
  }
}

if ($BaseUrl -match '__STEP_RELEASE_BASE_URL__') {
  Stop-WithError 'release base URL was not configured in this installer'
}

$workDir = Join-Path ([IO.Path]::GetTempPath()) ("step-harness-install-" + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null

  Write-Progress-Step -Step 1 -Total 6 -Message 'detecting platform'
  $targetId = Get-TargetId

  Write-Progress-Step -Step 2 -Total 6 -Message 'resolving release manifest'
  $manifestVersion = if ($Version -eq 'latest') { 'latest' } else { Normalize-Version -InputVersion $Version }
  $manifestUrl = if ($manifestVersion -eq 'latest') {
    "$BaseUrl/latest.json"
  } else {
    "$BaseUrl/$manifestVersion/manifest.json"
  }
  $manifest = Get-Manifest -ManifestUrl $manifestUrl
  $resolvedVersion = [string](Get-ObjectProperty -Object $manifest -Name 'version')
  if (-not $resolvedVersion) {
    $resolvedVersion = $manifestVersion
  } elseif ($resolvedVersion -ne 'latest') {
    $resolvedVersion = Normalize-Version -InputVersion $resolvedVersion
  }
  $packageUrl = Get-PackageUrl -Manifest $manifest -TargetId $targetId
  $expectedSha256 = Get-PackageChecksum -Manifest $manifest -TargetId $targetId

  Write-Progress-Step -Step 3 -Total 6 -Message 'downloading package'
  $archivePath = Join-Path $workDir 'release.zip'
  Invoke-Download -Url $packageUrl -Destination $archivePath
  Test-ArchiveChecksum -ArchivePath $archivePath -ExpectedSha256 $expectedSha256

  Write-Progress-Step -Step 4 -Total 6 -Message 'installing binary and runtime files'
  $extractDir = Join-Path $workDir 'extract'
  Install-Package -ArchivePath $archivePath -ExtractDir $extractDir -Destination $InstallDir

  Write-Progress-Step -Step 5 -Total 6 -Message 'installing managed fd and rg tools'
  Install-ManagedTools -TargetId $targetId -WorkDir $workDir

  Write-Progress-Step -Step 6 -Total 6 -Message 'running smoke test'
  Test-Install -BinaryPath (Join-Path $InstallDir 'step.exe')
  Write-Result -ResolvedVersion $resolvedVersion
} catch {
  Write-Host "  error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
