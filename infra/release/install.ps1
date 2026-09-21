#Requires -Version 5.1
<#
.SYNOPSIS
  Install or update StepCode on Windows.

.DESCRIPTION
  This is the Windows counterpart to infra/release/install.sh.  Release
  manifests are authoritative for the package URL and checksum; the installer
  only knows how to select the current Windows architecture and lay out the
  files expected by the Step runtime.

.PARAMETER Version
  A release version (vX.Y.Z, step-vX.Y.Z, refs/tags/vX.Y.Z) or latest.

.PARAMETER InstallDir
  Directory containing step.exe. Defaults to STEP_INSTALL_DIR or
  %USERPROFILE%\.stepcode\bin.

.PARAMETER AgentDir
  Step agent data directory. Managed fd/rg binaries are placed in its bin
  subdirectory. Defaults to STEP_CODING_AGENT_DIR or
  %USERPROFILE%\.stepcode\agent.
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
    Join-Path $HomeDir '.stepcode\bin'
  }
}
if (-not $AgentDir) {
  $AgentDir = if ($env:STEP_CODING_AGENT_DIR) {
    $env:STEP_CODING_AGENT_DIR
	} else {
    Join-Path $HomeDir '.stepcode\agent'
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
    return Invoke-RestMethod -Uri $ManifestUrl -Headers @{ 'User-Agent' = 'stepcode-installer' } -UseBasicParsing
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
    Invoke-WebRequest -Uri $Url -OutFile $Destination -Headers @{ 'User-Agent' = 'stepcode-installer' } -UseBasicParsing
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
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [string]$ExtractDir
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

  # Prefer the binary shipped inside the release archive (tools\) so a packaged
  # install needs no network. Fall back to the GitHub download below when the
  # archive did not carry it.
  if ($ExtractDir) {
    $bundled = Join-Path $ExtractDir (Join-Path 'tools' $binaryName)
    if (Test-Path -LiteralPath $bundled -PathType Leaf) {
      New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
      Copy-FileWithRetry -Source $bundled -Destination $destination
      return
    }
  }

  try {
    $metadataUrl = "https://api.github.com/repos/$Repository/releases/latest"
    $metadata = Invoke-RestMethod -Uri $metadataUrl -Headers @{ 'User-Agent' = 'stepcode-installer'; Accept = 'application/vnd.github+json' } -UseBasicParsing
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
    # migration can still provide them, and grep/find fall back to git/POSIX at
    # runtime, so a failed optional download is silently ignored (no warning).
  }
}

function Install-ManagedTools {
  param(
    [Parameter(Mandatory = $true)][string]$TargetId,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [string]$ExtractDir
  )
  New-Item -ItemType Directory -Path (Join-Path $AgentDir 'bin') -Force | Out-Null
  Install-ManagedTool -Name 'fd' -Repository 'sharkdp/fd' -TargetId $TargetId -WorkDir $WorkDir -ExtractDir $ExtractDir
  Install-ManagedTool -Name 'rg' -Repository 'BurntSushi/ripgrep' -TargetId $TargetId -WorkDir $WorkDir -ExtractDir $ExtractDir
}

function Test-Install {
  param([Parameter(Mandatory = $true)][string]$BinaryPath)
  & $BinaryPath --version *> $null
  if ($LASTEXITCODE -ne 0) {
    Stop-WithError 'installed step failed smoke test'
  }
}

function Get-MissingPathEntries {
  # Return the entries from $Candidates that are not already present in the
  # persistent PATH string $PathValue. $PathValue is the un-expanded registry
  # value; $Candidates are the (already expanded) directories we want on PATH.
  #
  # Idempotency depends on comparing *expanded* paths: a literal candidate such
  # as C:\Users\me\.stepcode\bin must match an existing %USERPROFILE%\.stepcode\bin
  # entry, otherwise every run double-appends. So each existing entry is run
  # through [Environment]::ExpandEnvironmentVariables() FOR COMPARISON ONLY --
  # the caller writes the original un-expanded strings back untouched. On top of
  # that, comparison is case-insensitive and trailing-backslash normalized.
  param(
    [AllowNull()][AllowEmptyString()][string]$PathValue,
    [Parameter(Mandatory = $true)][string[]]$Candidates
  )
  # Set-StrictMode makes $null.Split(...) throw; coalesce before any string call.
  if ($null -eq $PathValue) { $PathValue = '' }

  $existing = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($entry in ($PathValue -split ';')) {
    if ($entry) {
      [void]$existing.Add([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\').ToLowerInvariant())
    }
  }

  $missing = @()
  foreach ($candidate in $Candidates) {
    $normalized = [Environment]::ExpandEnvironmentVariables($candidate).TrimEnd('\').ToLowerInvariant()
    if (-not $existing.Contains($normalized)) {
      $missing += $candidate
    }
  }
  return $missing
}

function Send-EnvironmentChangeBroadcast {
  # Broadcast WM_SETTINGCHANGE so Explorer and subsequently-launched processes
  # pick up the new PATH without a reboot. It does NOT refresh already-open
  # shells' $env:PATH -- those must be reopened. Best-effort: a broadcast failure
  # must never fail the install.
  try {
    # Unique type name (namespaced) so a repeated Add-Type in the same session
    # -- e.g. self-update re-running the installer -- does not throw; guard on
    # the type already being loaded before defining it again.
    $typeName = 'StepCodeInstaller.NativeEnvironmentBroadcast'
    if (-not ([System.Management.Automation.PSTypeName]$typeName).Type) {
      Add-Type -Namespace 'StepCodeInstaller' -Name 'NativeEnvironmentBroadcast' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
    }
    $HWND_BROADCAST = [IntPtr]0xffff
    $WM_SETTINGCHANGE = 0x001A
    $SMTO_ABORTIFHUNG = 0x0002
    $result = [UIntPtr]::Zero
    [void][StepCodeInstaller.NativeEnvironmentBroadcast]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [IntPtr]::Zero, 'Environment', $SMTO_ABORTIFHUNG, 5000, [ref]$result)
  } catch {
    # Ignore: notifying other processes is a convenience, not a requirement.
  }
}

function Write-Result {
  param([Parameter(Mandatory = $true)][string]$ResolvedVersion)
  $binaryPath = Join-Path $InstallDir 'step.exe'
  Write-Host "  installed stepcode $ResolvedVersion to $binaryPath" -ForegroundColor Green

  # Persist $InstallDir / $AgentDir\bin as resolved (these already carry any
  # custom STEP_INSTALL_DIR / STEP_CODING_AGENT_DIR values), not hardcoded
  # defaults.
  $managedBin = Join-Path $AgentDir 'bin'
  $candidates = @($InstallDir, $managedBin)

  try {
    # Persist PATH by writing HKCU\Environment directly. This is deliberate --
    # do NOT "simplify" it into setx or [Environment]::SetEnvironmentVariable:
    #   * SetEnvironmentVariable('Path',...,'User') reads the already-expanded
    #     value and writes it back as REG_SZ, permanently flattening any
    #     REG_EXPAND_SZ entry (e.g. %USERPROFILE%\bin, %JAVA_HOME%\bin) to a
    #     literal -- data corruption for anyone whose PATH uses %VAR%.
    #   * setx truncates PATH at 1024 characters.
    # A direct registry read with DoNotExpandEnvironmentNames + write with
    # RegistryValueKind.ExpandString is the only route that both preserves
    # %VAR% references un-expanded and avoids the 1024-char truncation.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $key) {
      # A pristine user profile may not have the Environment subkey yet.
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    }
    try {
      $currentPath = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      # Coalesce a missing/null value to '' BEFORE any string method (StrictMode).
      if ($null -eq $currentPath) { $currentPath = '' }
      $currentPath = [string]$currentPath

      $missing = @(Get-MissingPathEntries -PathValue $currentPath -Candidates $candidates)
      if ($missing.Count -gt 0) {
        # Join without producing ';;' or a leading ';'.
        $trimmed = $currentPath.TrimEnd(';')
        $newPath = if ($trimmed) { $trimmed + ';' + ($missing -join ';') } else { $missing -join ';' }
        # Write the original un-expanded PATH plus the new dirs as ExpandString
        # so any %VAR% entries survive.
        $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)

        # Update the current session too. Append (do not prepend) so a
        # pre-existing system `step` earlier on PATH is not shadowed. Guarded on
        # $missing being non-empty so this never leaves a trailing ';'.
        $env:PATH = ($env:PATH.TrimEnd(';') + ';' + ($missing -join ';'))

        Send-EnvironmentChangeBroadcast

        Write-Host ''
        Write-Log 'added to your PATH (User):'
        foreach ($entry in $missing) {
          Write-Host "  $entry"
        }
        Write-Log 'open a new shell to use step'
      }
    } finally {
      $key.Close()
    }
  } catch {
    # Locked-down HKCU (or any registry failure): degrade to the printed
    # advisory rather than failing the install.
    $pathEntries = @($env:PATH -split ';' | Where-Object { $_ })
    $missing = @($candidates | Where-Object { $pathEntries -notcontains $_ })
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
}

# Detect an installer that was published without base-URL substitution. The
# sentinel is assembled from two literals so the release renderer's token
# replacement cannot rewrite this guard along with the real placeholder above.
$unconfiguredBaseUrl = '__STEP_RELEASE' + '_BASE_URL__'
if ($BaseUrl -eq $unconfiguredBaseUrl) {
  Stop-WithError 'release base URL was not configured in this installer'
}

$workDir = Join-Path ([IO.Path]::GetTempPath()) ("stepcode-install-" + [Guid]::NewGuid().ToString('N'))
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
  Install-ManagedTools -TargetId $targetId -WorkDir $workDir -ExtractDir $extractDir

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
