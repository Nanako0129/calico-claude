<#
calico update.ps1 -- unattended local updater for patched Claude Code builds on
Windows, published by a Calico release repo (default: Nanako0129/calico-claude).
The Windows counterpart of update.sh next to it; read that file for the reasons
behind the shared rules. This file stays pure ASCII: Windows PowerShell 5.1
reads a BOM-less UTF-8 script as the ANSI code page.

It manages a SEPARATELY NAMED launcher, %USERPROFILE%\.local\bin\calico-claude.exe,
which is a plain copy (no symlinks). The official claude.exe and
%USERPROFILE%\.local\share\claude are never read or written.

Modes (-Mode):
  hook            Throttled entry point. Never blocks: inside the throttle window
                  it exits 0; otherwise it stamps last-check and starts a
                  detached `-Mode unattended-run` child, then exits 0. No token
                  is ever passed to the child; it derives its own.
  unattended-run  What hook starts (and a future timer runs): run, but with the
                  repo read from %USERPROFILE%\.claude\calico\config only and
                  every path from USERPROFILE. CALICO_REPO, the CALICO_* path
                  overrides, GH_HOST and GH_REPO are ignored.
  run             Update if a newer verified release exists.
  force           run, but skip only the "already up to date" gate.
  check           Report installed vs latest. Changes nothing.
-PinTag <tag>     run/force only: install exactly that published tag, skipping
                  the version gate. Every verification still runs.

Environment (interactive modes only unless noted): CALICO_REPO,
CALICO_BIN_LINK (launcher path), CALICO_VERSIONS_DIR, CALICO_STATE_DIR; all
modes: CALICO_PLATFORM (win32-x64 | win32-arm64), CALICO_KEEP_VERSIONS
(default 3, 0 = keep all), CALICO_THROTTLE_SECONDS (default 3600). API token:
GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`.
#>
param(
  [string]$Mode = "",
  [string]$PinTag = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$DefaultRepo = 'Nanako0129/calico-claude'
$AssetName = 'claude.native.windows.patched.exe'
$MutexName = 'Local\calico-claude-update'
$LogMaxLines = 2000

$StateDir = $null
$LogFile = $null

function Write-Log {
  param([string]$Message)
  $line = '{0} [calico] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  if (-not $script:LogFile) { return }
  try {
    if (-not (Test-Path -LiteralPath $script:StateDir)) {
      New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
    }
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
  } catch { }
}

function Stop-Update {
  param([string]$Message)
  Write-Log "ERROR: $Message"
  exit 1
}

# The unattended modes inherit an environment someone else chose: a Claude Code
# session, to which a project's settings can add variables. Honouring
# CALICO_REPO there would let one workspace point every later update at another
# repository, whose own CI can produce matching checksums and attestations. So
# they take the repo from one config file and every path from USERPROFILE, and
# drop GH_HOST/GH_REPO so gh cannot be pointed elsewhere for the attestation.
function Set-Paths {
  param([bool]$Unattended)
  $userHome = $env:USERPROFILE
  if (-not $userHome) { throw 'USERPROFILE is not set' }
  $defaultState = Join-Path $userHome '.claude\calico'
  $defaultVersions = Join-Path $userHome '.local\share\calico-claude\versions'
  $defaultLauncher = Join-Path $userHome '.local\bin\calico-claude.exe'
  $script:Repo = $DefaultRepo
  if ($Unattended) {
    $script:StateDir = $defaultState
    $script:VersionsDir = $defaultVersions
    $script:Launcher = $defaultLauncher
    $config = Join-Path $script:StateDir 'config'
    if (Test-Path -LiteralPath $config -PathType Leaf) {
      foreach ($line in [IO.File]::ReadAllLines($config)) {
        if ($line -cmatch '^repo=([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)\z') {
          $script:Repo = $Matches[1]
          break
        }
      }
    }
    Remove-Item -LiteralPath Env:GH_HOST, Env:GH_REPO -ErrorAction SilentlyContinue
  } else {
    if ($env:CALICO_REPO) { $script:Repo = $env:CALICO_REPO }
    $script:StateDir = if ($env:CALICO_STATE_DIR) { $env:CALICO_STATE_DIR } else { $defaultState }
    $script:VersionsDir = if ($env:CALICO_VERSIONS_DIR) { $env:CALICO_VERSIONS_DIR } else { $defaultVersions }
    $script:Launcher = if ($env:CALICO_BIN_LINK) { $env:CALICO_BIN_LINK } else { $defaultLauncher }
  }
  $script:LogFile = Join-Path $script:StateDir 'update.log'
  $script:LastCheckFile = Join-Path $script:StateDir 'last-check'
  $script:RecordFile = Join-Path $script:StateDir 'installed-tag'
  $script:BinDir = Split-Path -Parent $script:Launcher
  $script:Leaf = Split-Path -Leaf $script:Launcher

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $script:Suffix = if ($env:CALICO_PLATFORM) { $env:CALICO_PLATFORM }
    elseif ("$arch" -eq 'AMD64') { 'win32-x64' }
    elseif ("$arch" -eq 'ARM64') { 'win32-arm64' }
    else { '' }
  if ($script:Suffix -cne 'win32-x64' -and $script:Suffix -cne 'win32-arm64') {
    throw "Unsupported Windows platform: '$($script:Suffix)' (architecture $arch)"
  }
}

# Every native call goes through here. Success is $LASTEXITCODE and nothing
# else: under 'Stop', Windows PowerShell 5.1 turns any stderr line of a
# redirected native command into a terminating error, so a gh that succeeded
# with a notice on stderr would read as a failure, and whether a failure wrote
# stderr says nothing about whether it failed.
function Invoke-Native {
  param([string]$FilePath, [string[]]$ArgumentList)
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $out = & $FilePath @ArgumentList 2>&1
    $code = $LASTEXITCODE
  } catch {
    return [pscustomobject]@{ ExitCode = $null; Output = $_.Exception.Message }
  }
  $text = (@($out) | ForEach-Object { "$_" }) -join "`n"
  return [pscustomobject]@{ ExitCode = $code; Output = $text }
}

# Leading X.Y.Z of the first output line, as a whole token: "2.1.24" is a
# substring of "2.1.240", so substring tests would pass a mislabeled build.
function Get-VersionToken {
  param([string]$Text)
  $first = ("$Text" -split "`n")[0]
  if ($first -cmatch '^\D*(\d+(?:\.\d+)+)') { return $Matches[1] }
  return ''
}

function Test-VersionOutput {
  param([string]$Text, [string]$Expected)
  return ("$Text".Contains('(patched)') -and ((Get-VersionToken $Text) -ceq $Expected))
}

function Get-TagVersion {
  param([string]$Tag)
  if ($Tag -cmatch '^v(\d+\.\d+\.\d+)-') { return $Matches[1] }
  return ''
}

# A corrected build is republished as -<n>; the base tag ranks 1. Platform
# suffixes such as x64 are not bare integers, so a base tag never misreads.
function Get-TagRank {
  param([string]$Tag)
  $last = ($Tag -split '-')[-1]
  if ($last -cmatch '^\d+\z') { return [int]$last }
  return 1
}

function Read-Record {
  if (-not (Test-Path -LiteralPath $script:RecordFile -PathType Leaf)) { return $null }
  $tag = ''
  $sha = ''
  foreach ($line in [IO.File]::ReadAllLines($script:RecordFile)) {
    if ($line -cmatch '^tag=(v\d+\.\d+\.\d+-\S+)\z') { $tag = $Matches[1] }
    elseif ($line -cmatch '^sha256=([0-9A-Fa-f]{64})\z') { $sha = $Matches[1] }
  }
  if (-not $tag -or -not $sha) { return $null }
  return [pscustomobject]@{ Tag = $tag; Sha256 = $sha }
}

function Write-Record {
  param([string]$Tag, [string]$Sha256)
  if (-not (Test-Path -LiteralPath $script:StateDir)) {
    New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
  }
  [IO.File]::WriteAllText($script:RecordFile, "tag=$Tag`r`nsha256=$Sha256`r`n")
}

function Restore-Record {
  param($Previous)
  try {
    if ($null -eq $Previous) { Remove-Item -LiteralPath $script:RecordFile -Force -ErrorAction SilentlyContinue }
    else { [IO.File]::WriteAllText($script:RecordFile, $Previous) }
  } catch { Write-Log "WARNING: could not restore $($script:RecordFile): $($_.Exception.Message)" }
}

# The launcher is a plain file, so nothing on disk says who put it there. The
# record (tag + SHA256 of the launcher this script installed) is that proof:
#   no launcher                     -> install
#   launcher, no usable record      -> refuse; it is not ours to replace
#   launcher hash != recorded hash  -> refuse; someone else wrote it
#   hash matches                    -> installed version comes from running it;
#     if the record's version is not that version, its rebuild rank means
#     nothing, so rank 0 makes the latest rebuild of this version reinstall.
function Get-InstalledState {
  $state = [pscustomobject]@{ Present = $false; Version = ''; Rank = 0; Refusal = $null }
  if (-not (Test-Path -LiteralPath $script:Launcher)) { return $state }
  $state.Present = $true
  $record = Read-Record
  if ($null -eq $record) {
    $state.Refusal = "$($script:Launcher) exists but $($script:RecordFile) holds no record of this updater installing it; refusing to replace it. Move it aside if it should be managed here."
    return $state
  }
  $hash = (Get-FileHash -LiteralPath $script:Launcher -Algorithm SHA256).Hash
  if ($hash -ne $record.Sha256) {
    $state.Refusal = "$($script:Launcher) does not match the recorded SHA256 of the build this updater installed ($($record.Tag)); something else replaced it. Refusing to overwrite it."
    return $state
  }
  $out = (Invoke-Native $script:Launcher @('--version')).Output
  if ($out.Contains('(patched)')) { $state.Version = Get-VersionToken $out }
  if ($state.Version -and (Get-TagVersion $record.Tag) -ceq $state.Version) {
    $state.Rank = Get-TagRank $record.Tag
  }
  return $state
}

function Get-ApiToken {
  if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
  if ($env:GH_TOKEN) { return $env:GH_TOKEN }
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $ErrorActionPreference = 'Continue'
    $token = (& gh auth token 2>$null) -join ''
    if ($LASTEXITCODE -eq 0 -and $token) { return $token.Trim() }
  }
  return ''
}

# Highest non-draft, non-prerelease v<X.Y.Z>-<suffix>[-<rebuild>] carrying our
# asset, or exactly -PinTag. A prerelease carrying a mistyped high version would
# otherwise become every machine's target and outrank each release after it.
function Get-TargetRelease {
  $headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'calico-claude-updater' }
  $token = Get-ApiToken
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $uri = "https://api.github.com/repos/$($script:Repo)/releases?per_page=100"
  try {
    $releases = Invoke-RestMethod -Uri $uri -Headers $headers
  } catch {
    Stop-Update "Failed to query GitHub releases API for $($script:Repo): $($_.Exception.Message)"
  }
  $pattern = '^v(\d+)\.(\d+)\.(\d+)-' + [regex]::Escape($script:Suffix) + '(?:-(\d+))?\z'
  $best = $null
  foreach ($rel in @($releases)) {
    if ($null -eq $rel -or $rel.draft -or $rel.prerelease) { continue }
    $tag = [string]$rel.tag_name
    if (-not ($tag -cmatch $pattern)) { continue }
    $version = [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
    $rank = if ($Matches[4]) { [int]$Matches[4] } else { 1 }
    if ($PinTag -and $tag -cne $PinTag) { continue }
    $asset = @($rel.assets) | Where-Object { $_.name -ceq $AssetName } | Select-Object -First 1
    if (-not $asset) { continue }
    $sums = @($rel.assets) | Where-Object { $_.name -ceq 'checksums.txt' } | Select-Object -First 1
    if ($null -eq $best -or $version -gt $best.Version -or ($version -eq $best.Version -and $rank -gt $best.Rank)) {
      $best = [pscustomobject]@{
        Tag = $tag; Version = $version; Rank = $rank
        AssetUrl = [string]$asset.browser_download_url
        ChecksumsUrl = if ($sums) { [string]$sums.browser_download_url } else { '' }
      }
    }
  }
  return $best
}

# Asset downloads never carry the token: it is only needed for the API's rate
# limit, and a redirect target is another host.
function Save-Url {
  param([string]$Uri, [string]$OutFile)
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -Headers @{ 'User-Agent' = 'calico-claude-updater' }
}

# Exact name comparison only. A pattern match would let a decoy line such as
# "<hash>  xclaude.native.windows.patched.exe" (or an unescaped dot) satisfy it.
function Test-Checksum {
  param([string]$SumsFile, [string]$File)
  $entries = @()
  foreach ($line in [IO.File]::ReadAllLines($SumsFile)) {
    $parts = @($line.Trim() -split '\s+')
    if ($parts.Count -ne 2) { continue }
    $name = $parts[1]
    if ($name.StartsWith('*')) { $name = $name.Substring(1) }
    if ($name -ceq $AssetName) { $entries += $parts[0] }
  }
  if ($entries.Count -ne 1) {
    Stop-Update "checksums.txt has $($entries.Count) entries for $AssetName (expected exactly 1); refusing to install"
  }
  $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash
  if (-not [string]::Equals($entries[0], $actual, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Update "Checksum verification FAILED for $AssetName; refusing to install"
  }
  Write-Log "Checksum verified for $AssetName"
  return $actual
}

# Pinned to the release workflow on main: `--repo` alone accepts an attestation
# from any workflow or ref in the repository. A gh too old for the two flags
# fails and says so rather than being retried without them. Without gh at all
# the install proceeds on the checksum alone (see README: accepted risk).
function Test-Attestation {
  param([string]$File)
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Log 'WARNING: gh not found; skipping build attestation verification and trusting checksums.txt alone'
    return
  }
  if ((Invoke-Native 'gh' @('auth', 'status')).ExitCode -ne 0) {
    Write-Log 'WARNING: gh is not authenticated; skipping build attestation verification and trusting checksums.txt alone'
    return
  }
  $r = Invoke-Native 'gh' @('attestation', 'verify', $File, '--repo', $script:Repo,
    '--signer-workflow', "$($script:Repo)/.github/workflows/patch-claude.yml",
    '--source-ref', 'refs/heads/main')
  if ($r.ExitCode -eq 0) {
    Write-Log "Attestation verified via gh for $AssetName"
    return
  }
  if ($r.Output.Contains('unknown flag')) {
    Stop-Update "Installed gh cannot pin the signing workflow and ref (--signer-workflow/--source-ref); update gh. Refusing to install $AssetName"
  }
  Stop-Update "Attestation verification FAILED for $AssetName; refusing to install"
}

# Called only while holding the mutex, so no other run can own these files.
# Asides whose process still runs cannot be deleted and are left for later.
function Invoke-Housekeeping {
  if (Test-Path -LiteralPath $script:BinDir) {
    Get-ChildItem -LiteralPath $script:BinDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name.StartsWith("$($script:Leaf).calico-old.") -or $_.Name.StartsWith("$($script:Leaf).calico-new.") } |
      ForEach-Object {
        # Inside catch, $_ is the error record, not the file.
        $file = $_
        try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop; Write-Log "Removed $($file.Name)" }
        catch { Write-Log "Left $($file.Name) in place (still in use)" }
      }
  }
  $keep = 3
  if ("$env:CALICO_KEEP_VERSIONS" -cmatch '^\d+\z') { $keep = [int]$env:CALICO_KEEP_VERSIONS }
  if ($keep -gt 0 -and (Test-Path -LiteralPath $script:VersionsDir)) {
    Get-ChildItem -LiteralPath $script:VersionsDir -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $keep |
      ForEach-Object {
        $file = $_
        try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop; Write-Log "Pruned old version $($file.Name)" }
        catch { Write-Log "WARNING: could not prune $($file.Name): $($_.Exception.Message)" }
      }
  }
}

# Windows refuses to overwrite a running executable but allows renaming it, so
# the swap is exactly two renames inside one directory: launcher -> aside, then
# verified staging -> launcher. The record is written first and put back on any
# failure, so record and launcher never describe different builds.
function Install-Staged {
  param([string]$Staging, [string]$Tag, [string]$Sha256)
  $previous = $null
  if (Test-Path -LiteralPath $script:RecordFile -PathType Leaf) { $previous = [IO.File]::ReadAllText($script:RecordFile) }
  try {
    Write-Record $Tag $Sha256
  } catch {
    Write-Log "Cannot write $($script:RecordFile) ($($_.Exception.Message)); leaving $($script:Launcher) unchanged so the record and the launcher stay consistent."
    exit 0
  }

  $aside = $null
  if (Test-Path -LiteralPath $script:Launcher) {
    $aside = '{0}.calico-old.{1}' -f $script:Launcher, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try {
      Move-Item -LiteralPath $script:Launcher -Destination $aside -ErrorAction Stop
    } catch {
      Restore-Record $previous
      Stop-Update "Could not move $($script:Launcher) aside: $($_.Exception.Message)"
    }
    Write-Log "Renamed $($script:Launcher) -> $aside"
  }

  try {
    Move-Item -LiteralPath $Staging -Destination $script:Launcher -ErrorAction Stop
  } catch {
    $moveError = $_.Exception.Message
    try {
      # Anything at the launcher path now came from the failed move: the
      # original was renamed away above.
      if (Test-Path -LiteralPath $script:Launcher) { Remove-Item -LiteralPath $script:Launcher -Force -ErrorAction Stop }
      if ($aside) { Move-Item -LiteralPath $aside -Destination $script:Launcher -ErrorAction Stop }
    } catch {
      Restore-Record $previous
      Stop-Update "Could not install the new build ($moveError), and could not restore the previous launcher from $aside ($($_.Exception.Message)). Rename it back to $($script:Leaf) by hand."
    }
    Restore-Record $previous
    Stop-Update "Could not install the new build ($moveError); the previous launcher and record were restored."
  }
  Write-Log "Renamed $Staging -> $($script:Launcher)"

  if ($aside) {
    try {
      Remove-Item -LiteralPath $aside -Force -ErrorAction Stop
    } catch {
      Write-Log "Previous launcher is still in use; left as $(Split-Path -Leaf $aside) for a later run. Restart open sessions to run the new build."
    }
  }
}

function Invoke-Update {
  param([bool]$Force)
  New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
  $mutex = New-Object System.Threading.Mutex($false, $MutexName)
  $owned = $false
  $staging = $null
  $sums = $null
  try {
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
      Write-Log 'Another update is already in progress; exiting.'
      exit 0
    }
    Invoke-Housekeeping

    $state = Get-InstalledState
    if ($state.Refusal) { Stop-Update $state.Refusal }
    $shown = if ($state.Version) { $state.Version } else { '<none>' }
    Write-Log "Installed version: $shown ($($script:Suffix))"

    $rel = Get-TargetRelease
    if ($null -eq $rel) {
      if ($PinTag) { Stop-Update "Tag $PinTag is not a published, non-draft, non-prerelease $($script:Suffix) release with $AssetName" }
      Write-Log "No matching $($script:Suffix) release found for $($script:Repo); nothing to do."
      exit 0
    }
    $latest = $rel.Version.ToString()
    Write-Log "Target release: $latest (tag $($rel.Tag))"

    if ($PinTag) {
      Write-Log "Installing pinned tag $PinTag."
    } elseif ($state.Version) {
      $cmp = $rel.Version.CompareTo([version]$state.Version)
      if ($cmp -gt 0) {
      } elseif ($cmp -eq 0 -and $rel.Rank -gt $state.Rank) {
        Write-Log "Installed $($state.Version) matches latest, but $($rel.Tag) is a newer rebuild; reinstalling."
      } elseif ($Force) {
        Write-Log "Installed $($state.Version) is up to date, but force given; reinstalling."
      } elseif ($cmp -lt 0) {
        Write-Log "WARNING: installed $($state.Version) is newer than the latest release $latest; no update will be offered until a newer release is published."
        exit 0
      } else {
        Write-Log "Installed version $($state.Version) is up to date (latest $($rel.Tag)); nothing to do."
        exit 0
      }
    } elseif ($state.Present) {
      Write-Log "$($script:Launcher) does not report a patched version; reinstalling."
    }
    if (-not $rel.ChecksumsUrl) { Stop-Update "Release $($rel.Tag) has no checksums.txt asset; refusing to install" }

    # Staged inside the launcher's own directory so the final step is a rename
    # on one volume, never a copy over the launcher.
    New-Item -ItemType Directory -Force -Path $script:BinDir | Out-Null
    $staging = Join-Path $script:BinDir ('{0}.calico-new.{1}.exe' -f $script:Leaf, [guid]::NewGuid().ToString('N'))
    $sums = "$staging.sums"
    Write-Log "Downloading $AssetName ($($rel.Tag))"
    try {
      Save-Url $rel.AssetUrl $staging
      Save-Url $rel.ChecksumsUrl $sums
    } catch {
      Stop-Update "Failed to download release assets: $($_.Exception.Message)"
    }

    $sha256 = Test-Checksum $sums $staging
    Remove-Item -LiteralPath $sums -Force -ErrorAction SilentlyContinue
    Test-Attestation $staging
    $out = (Invoke-Native $staging @('--version')).Output
    $flat = $out -replace "`r?`n", ' | '
    if (-not (Test-VersionOutput $out $latest)) {
      Stop-Update "Downloaded $AssetName reports '$flat', expected $latest and (patched); refusing to install"
    }
    Write-Log "Artifact verified before install: $flat"

    New-Item -ItemType Directory -Force -Path $script:VersionsDir | Out-Null
    $archive = Join-Path $script:VersionsDir $latest
    if (Test-Path -LiteralPath $archive) {
      $archive = '{0}.{1}' -f $archive, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    Copy-Item -LiteralPath $staging -Destination $archive -ErrorAction Stop
    Write-Log "Kept a copy at $archive"

    Install-Staged $staging $rel.Tag $sha256
    Write-Log "Update to $($rel.Tag) complete."
    Invoke-Housekeeping
  } finally {
    # After a successful swap the staging path no longer exists.
    foreach ($leftover in @($staging, $sums)) {
      if ($leftover -and (Test-Path -LiteralPath $leftover)) { Remove-Item -LiteralPath $leftover -Force -ErrorAction SilentlyContinue }
    }
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Invoke-Check {
  $state = Get-InstalledState
  $rel = Get-TargetRelease
  "Platform:       $($script:Suffix)"
  "Installed:      $(if ($state.Version) { $state.Version } elseif ($state.Present) { '<unknown>' } else { '<none>' })"
  if ($null -eq $rel) {
    "Latest release: none (no matching $($script:Suffix) release published yet)"
    return
  }
  "Latest release: $($rel.Version) (tag $($rel.Tag))"
  if ($state.Refusal) {
    "Status:         refused: $($state.Refusal)"
  } elseif (-not $state.Version) {
    "Status:         install needed"
  } else {
    $cmp = $rel.Version.CompareTo([version]$state.Version)
    if ($cmp -gt 0) { "Status:         update available" }
    elseif ($cmp -lt 0) { "Status:         installed is newer than latest release" }
    elseif ($rel.Rank -gt $state.Rank) { "Status:         rebuild available ($($rel.Tag))" }
    else { "Status:         up to date" }
  }
}

function Invoke-Hook {
  try {
    New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $throttle = 3600
    if ("$env:CALICO_THROTTLE_SECONDS" -cmatch '^\d+\z') { $throttle = [long]$env:CALICO_THROTTLE_SECONDS }
    $last = [long]0
    if (Test-Path -LiteralPath $script:LastCheckFile) {
      [void][long]::TryParse(([IO.File]::ReadAllText($script:LastCheckFile)).Trim(), [ref]$last)
    }
    if ($now - $last -lt $throttle) { exit 0 }
    try { [IO.File]::WriteAllText($script:LastCheckFile, "$now") }
    catch { Write-Log "WARNING: could not write $($script:LastCheckFile); throttling is degraded." }

    if ((Test-Path -LiteralPath $script:LogFile) -and @([IO.File]::ReadAllLines($script:LogFile)).Count -gt $LogMaxLines) {
      $tail = @([IO.File]::ReadAllLines($script:LogFile)) | Select-Object -Last ($LogMaxLines / 2)
      [IO.File]::WriteAllLines($script:LogFile, [string[]]$tail)
    }

    # The child gets nothing but the mode. It re-derives the token itself; a
    # token in a command line is readable by every local process.
    $exe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode unattended-run' -f $PSCommandPath
    Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden
  } catch {
    Write-Log "WARNING: hook could not start an update: $($_.Exception.Message)"
  }
  exit 0
}

try {
  if ($PinTag -and $Mode -cne 'run' -and $Mode -cne 'force') {
    Write-Host '-PinTag is only valid with -Mode run or -Mode force.'
    exit 2
  }
  switch -CaseSensitive ($Mode) {
    'hook' { Set-Paths $true; Invoke-Hook }
    'unattended-run' { Set-Paths $true; Invoke-Update $false }
    'run' { Set-Paths $false; Invoke-Update $false }
    'force' { Set-Paths $false; Invoke-Update $true }
    'check' { Set-Paths $false; Invoke-Check }
    default {
      Write-Host 'Usage: update.ps1 -Mode hook|unattended-run|run|force|check [-PinTag <tag>]'
      Write-Host '  hook            Throttled SessionStart entry point; starts a detached unattended-run.'
      Write-Host '  unattended-run  run for the hook and a timer: repo from the config file only.'
      Write-Host '  run             Update if a newer verified release exists.'
      Write-Host '  force           Reinstall even when up to date (skips only the version gate).'
      Write-Host '  check           Report installed vs latest without changing anything.'
      Write-Host '  -PinTag <tag>   run/force only: install exactly that published tag.'
      exit 2
    }
  }
} catch {
  if ($Mode -ceq 'hook') { exit 0 }
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
