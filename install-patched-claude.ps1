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
# a string array. `-notmatch` against an array filters instead of testing — it
# returns the elements that did not match, and a non-empty array is truthy — so
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

$tmpDir = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()))
try {
  $downloadedPath = Join-Path $tmpDir.FullName $assetName
  Write-Host "Downloading $assetName from $releaseTag"
  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $downloadedPath

  Copy-Item -LiteralPath $downloadedPath -Destination $claudePath -Force

  Write-Host "Installed patched Claude to $claudePath"
  & $claudePath --version
} finally {
  Remove-Item -LiteralPath $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
