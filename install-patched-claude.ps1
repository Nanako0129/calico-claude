param(
  [string]$RepoSlug = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoSlug) {
  $RepoSlug = if ($env:PATCH_CLAUDE_REPO) { $env:PATCH_CLAUDE_REPO } else { "Nanako0129/calico-claude" }
}

function Fail {
  param([string]$Message)
  Write-Error "Error: $Message"
  exit 1
}

function Get-ReleaseSuffix {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

  switch ($arch.ToUpperInvariant()) {
    "AMD64" { return "win32-x64" }
    "ARM64" { return "win32-arm64" }
    default { Fail "Unsupported Windows architecture: $arch" }
  }
}

function Get-GitHubHeaders {
  $headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "patch-claude-code-installer"
  }

  if ($env:GITHUB_TOKEN) {
    $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)"
  } elseif ($env:GH_TOKEN) {
    $headers["Authorization"] = "Bearer $($env:GH_TOKEN)"
  } elseif (Get-Command gh -ErrorAction SilentlyContinue) {
    # Anonymous calls are capped at 60 an hour per address, and a shared egress
    # spends that for everyone behind it: a re-run behind Cloudflare WARP failed
    # to list releases with the limit at remaining=0. An authenticated gh is the
    # credential most users already have. An unauthenticated one prints nothing
    # to stdout and exits 1 ("no oauth token found for <host>" on stderr,
    # measured with gh on macOS; not measured on Windows), which leaves the
    # request anonymous as before.
    $ghToken = (& gh auth token 2>$null) -join ""
    if ($ghToken) {
      $headers["Authorization"] = "Bearer $ghToken"
    }
  }

  return $headers
}

$releaseSuffix = Get-ReleaseSuffix
$assetName = "claude.native.windows.patched.exe"
$apiBaseUrl = "https://api.github.com/repos/$RepoSlug"

$claudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $claudeCommand) {
  Fail "Could not find an existing native Claude installation. Install the official native Claude binary first, then run this installer again."
}

$claudePath = if ($claudeCommand.Source) { $claudeCommand.Source } else { $claudeCommand.Path }
if (-not $claudePath) {
  Fail "Could not resolve the installed Claude executable path."
}

# Joined before matching, because the binary this installer upgrades is usually
# one it installed itself: the version-output patch module appends a "(patched)"
# line, so `claude --version` prints two lines and PowerShell hands them back as
# a string array. `-notmatch` against an array filters instead of testing: it
# returns the elements that did not match, and a non-empty array is truthy, so
# the check failed on exactly the machines that already had a patched build,
# while a first install over the official single-line binary always passed.
# $Matches is not populated by the array form either, so the $claudeVersion
# assignment below could not have worked even if the test had.
$versionOutput = (& $claudePath --version 2>$null) -join "`n"
if ($versionOutput -notmatch "([0-9]+\.[0-9]+\.[0-9]+)") {
  Fail "Could not parse Claude version from: $versionOutput"
}

$claudeVersion = $Matches[1]
$releaseTag = "v$claudeVersion-$releaseSuffix"
$headers = Get-GitHubHeaders
$releaseApiUrl = "$apiBaseUrl/releases?per_page=100"

try {
  $releases = Invoke-RestMethod -Uri $releaseApiUrl -Headers $headers
} catch {
  Fail "Could not list patched releases for Claude $claudeVersion on $releaseSuffix"
}

$escapedTag = [regex]::Escape($releaseTag)
$release = $releases |
  Where-Object { -not $_.draft -and $_.tag_name -match "^$escapedTag(?:-(\d+))?$" } |
  ForEach-Object {
    $rank = if ($_.tag_name -match "-(\d+)$") { [int]$Matches[1] } else { 1 }
    [pscustomobject]@{ Rank = $rank; Release = $_ }
  } |
  Sort-Object Rank -Descending |
  Select-Object -First 1 |
  Select-Object -ExpandProperty Release

if (-not $release) {
  Fail "Could not find $releaseTag or a published rebuild suffix"
}
$releaseTag = $release.tag_name

$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
  Fail "Could not find the $assetName asset in release $releaseTag"
}

# Windows refuses to overwrite an executable that any process is running, and
# people usually re-run this installer from inside a Claude Code session: a
# plain Copy-Item then failed with "The process cannot access the file ...
# because it is being used by another process" (two sessions held claude.exe on
# the Windows box this was found on). Renaming a running executable is allowed,
# though, and frees its name. Measured on Windows x64 against a running
# stand-in: the overwrite failed, the rename succeeded, the new file copied into
# the freed name and ran, and the old process kept running. Anthropic's updater
# does the same, moving the exe aside as <exe>.old.<ms> and moving it back if
# the replacement fails (read from the 2.1.280 bundle).
#
# The aside name is deliberately not <exe>.old.<ms>: the official updater keeps
# its own files under that name in this directory and has sweep and restore
# logic for them that was not traced, so the two sets must not be mistaken for
# each other.
function Install-OverRunningExe {
  param([string]$Source, [string]$Target)

  $leaf = Split-Path -Leaf $Target
  $dir = Split-Path -Parent $Target
  $asidePrefix = "$leaf.calico-old."

  # Asides from earlier runs whose process has since exited. One still in use
  # cannot be deleted (measured: UnauthorizedAccessException) and is left for
  # the next run.
  Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith($asidePrefix) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

  $aside = Join-Path $dir ($asidePrefix + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  try {
    Move-Item -LiteralPath $Target -Destination $aside -ErrorAction Stop
  } catch {
    Fail "Could not move the existing $leaf aside to replace it: $($_.Exception.Message)"
  }

  try {
    Copy-Item -LiteralPath $Source -Destination $Target -ErrorAction Stop
  } catch {
    $copyError = $_.Exception.Message
    try {
      # A copy that fails partway (a full disk) can leave a partial file at
      # $Target, and Move-Item will not overwrite an existing file. Measured with
      # a fault-injected copy that wrote part of the target and then threw: the
      # restore failed and left a 7-byte claude.exe with the original stranded
      # in the aside. Anything at $Target now is that partial copy, since the
      # original was moved away above.
      if (Test-Path -LiteralPath $Target) {
        Remove-Item -LiteralPath $Target -Force -ErrorAction Stop
      }
      Move-Item -LiteralPath $aside -Destination $Target -ErrorAction Stop
    } catch {
      Fail "Could not install the patched build ($copyError), and could not restore the original from $aside ($($_.Exception.Message)). Rename it back to $leaf by hand."
    }
    Fail "Could not install the patched build: $copyError. The original $leaf was restored."
  }

  try {
    Remove-Item -LiteralPath $aside -Force -ErrorAction Stop
  } catch {
    # A process is still running the previous build. It keeps working, but it
    # is the old binary: only sessions started from now on run the patched one.
    Write-Host "The previous $leaf is still in use by a running Claude Code session; it was"
    Write-Host "moved to $(Split-Path -Leaf $aside) and will be removed on a later run. Restart"
    Write-Host "open sessions to run the patched build."
  }
}

$tmpDir = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()))
try {
  $downloadedPath = Join-Path $tmpDir.FullName $assetName
  Write-Host "Downloading $assetName from $releaseTag"
  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $downloadedPath

  Install-OverRunningExe -Source $downloadedPath -Target $claudePath

  Write-Host "Installed patched Claude to $claudePath"
  & $claudePath --version

  # The next upstream release puts claude back on an unpatched build without a
  # word; users found out by noticing "(patched)" had gone from
  # `claude --version`. Observed on a Windows x64 install, within half an hour
  # of this installer putting a patched 2.1.278 there: the updater wrote
  # versions\2.1.280 and, in the same second, rewrote claude.exe (a plain file,
  # no link) to the identical byte length, after which `claude --version` read
  # "2.1.280 (Claude Code)" and nothing else. Say so at the moment it becomes
  # true. DISABLE_AUTOUPDATER is the switch the native updater reads: its update
  # check returns early on it (measured in the 2.1.280 bundle).
  Write-Host ""
  Write-Host "Note: this replaced the claude.exe that Anthropic's updater manages. When the"
  Write-Host "next Claude Code release installs, claude goes back to an unpatched build and"
  Write-Host "``claude --version`` stops showing ""(patched)"". To keep it patched, start Claude"
  Write-Host "Code with DISABLE_AUTOUPDATER=1 in its environment and re-run this installer"
  Write-Host "yourself after upgrading. See:"
  Write-Host "  https://github.com/Nanako0129/calico-claude#keeping-it-updated"
} finally {
  Remove-Item -LiteralPath $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
