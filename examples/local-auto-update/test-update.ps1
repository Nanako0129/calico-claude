<#
Offline self-check for update.ps1. Runs under PowerShell 7 and Windows
PowerShell 5.1, on Windows only (it compiles a stand-in claude.exe with the
.NET Framework csc.exe that ships with Windows).

  pwsh -NoProfile -ExecutionPolicy Bypass -File test-update.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File test-update.ps1
  ... -UpdateScript <path>   test another copy (used for mutation runs)

The network is stubbed by shadowing Invoke-RestMethod, Invoke-WebRequest,
Start-Process and Move-Item with functions: update.ps1 runs in a child scope of
this script, and a function wins over a cmdlet of the same name. gh is a .cmd
stub on PATH. USERPROFILE and HOME point into a sandbox under %TEMP% for every
case, so the real profile is never read or written. Pure ASCII, like
update.ps1, for Windows PowerShell 5.1.
#>
param([string]$UpdateScript = '')

$ErrorActionPreference = 'Stop'
if (-not $UpdateScript) { $UpdateScript = Join-Path $PSScriptRoot 'update.ps1' }
$UpdateScript = (Resolve-Path -LiteralPath $UpdateScript).Path

$AssetName = 'claude.native.windows.patched.exe'
$Sentinel = 'calico-test-token-7f3a9c51'
$Sandbox = Join-Path ([IO.Path]::GetTempPath()) ('calico-update-test-' + [guid]::NewGuid().ToString('N'))
$StubBin = Join-Path $Sandbox 'stub-bin'
$EnvNames = @('USERPROFILE', 'HOME', 'PATH', 'GITHUB_TOKEN', 'GH_TOKEN', 'GH_HOST', 'GH_REPO',
  'CALICO_REPO', 'CALICO_BIN_LINK', 'CALICO_VERSIONS_DIR', 'CALICO_STATE_DIR', 'CALICO_PLATFORM',
  'CALICO_KEEP_VERSIONS', 'CALICO_THROTTLE_SECONDS', 'CALICO_TEST_GH_LOG', 'CALICO_TEST_GH_RC',
  'CALICO_TEST_GH_AUTH_RC', 'CALICO_TEST_GH_STDERR', 'CALICO_TEST_GH_TOKEN')
$SavedEnv = @{}
foreach ($n in $EnvNames) { $SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n) }
$Holders = New-Object System.Collections.ArrayList
$Pass = 0
$Fail = 0
$CaseNo = 0

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) { $script:Pass++; Write-Host "ok   $($script:Case): $Name" }
  else {
    $script:Fail++
    Write-Host "FAIL $($script:Case): $Name $Detail"
    Write-Host ('       log: ' + ((Read-Log) -replace "`r?`n", "`n       log: "))
  }
}

# --- Stubs (state lives in $global: because the stubs run in update.ps1's scope)
function New-Stub {
  $global:CalicoStub = @{
    Releases = @(); Files = @{}; ApiError = $null; PartialAsset = $false; FailStagingRename = $false
    Api = New-Object System.Collections.ArrayList
    Downloads = New-Object System.Collections.ArrayList
    Spawned = New-Object System.Collections.ArrayList
  }
}

function Invoke-RestMethod {
  param([string]$Uri, [hashtable]$Headers)
  [void]$global:CalicoStub.Api.Add([pscustomobject]@{ Uri = $Uri; Auth = $Headers['Authorization'] })
  if ($global:CalicoStub.ApiError) { throw $global:CalicoStub.ApiError }
  return $global:CalicoStub.Releases
}

function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, $Headers, [switch]$UseBasicParsing)
  $auth = $null
  if ($Headers) { $auth = $Headers['Authorization'] }
  [void]$global:CalicoStub.Downloads.Add([pscustomobject]@{ Uri = $Uri; Auth = $auth })
  $source = $global:CalicoStub.Files[$Uri]
  if (-not $source) { throw "404 Not Found: $Uri" }
  if ($global:CalicoStub.PartialAsset -and $Uri.EndsWith($AssetName)) {
    [IO.File]::WriteAllBytes($OutFile, [byte[]](1, 2, 3, 4, 5, 6, 7))
    throw 'The connection was reset (injected)'
  }
  [IO.File]::Copy($source, $OutFile, $true)
}

function Start-Process {
  param([string]$FilePath, $ArgumentList, [string]$WindowStyle)
  [void]$global:CalicoStub.Spawned.Add(('{0} {1}' -f $FilePath, (@($ArgumentList) -join ' ')))
}

# Fault injection for the second rename: leave a partial file where the
# launcher goes, then fail, which is the worst shape a failed move can leave.
function Move-Item {
  [CmdletBinding()]
  param([string]$LiteralPath, [string]$Destination)
  if ($global:CalicoStub.FailStagingRename -and (Split-Path -Leaf $LiteralPath).Contains('.calico-new.') -and
      -not (Split-Path -Leaf $Destination).Contains('.calico-')) {
    [IO.File]::WriteAllBytes($Destination, [byte[]](1, 2, 3, 4, 5, 6, 7))
    throw 'Access to the path is denied (injected)'
  }
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
}

# --- Fixtures -----------------------------------------------------------------
function New-Fake {
  # The stand-in prints whatever follows the marker in its own file, with \n as
  # a newline, and `--hold <s>` sleeps instead, so one compile serves every case
  # and each variant has its own hash.
  param([string]$Path, [string]$Output)
  $bytes = $script:FakeBase + [Text.Encoding]::ASCII.GetBytes('@@CALICO-OUT@@' + $Output)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllBytes($Path, [byte[]]$bytes)
  return $Path
}

function Get-Sha { param([string]$Path) (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

function Add-Release {
  param([string]$Tag, [string]$AssetFile, [string]$Sums, [switch]$Draft, [switch]$Prerelease)
  $base = "https://example.invalid/download/$Tag"
  $assetUrl = "$base/$AssetName"
  $sumsUrl = "$base/checksums.txt"
  if (-not $PSBoundParameters.ContainsKey('Sums')) { $Sums = "$((Get-Sha $AssetFile).ToLowerInvariant())  $AssetName" }
  $sumsFile = Join-Path $Sandbox ("sums-" + [guid]::NewGuid().ToString('N') + '.txt')
  [IO.File]::WriteAllText($sumsFile, $Sums + "`n")
  $global:CalicoStub.Files[$assetUrl] = $AssetFile
  $global:CalicoStub.Files[$sumsUrl] = $sumsFile
  $global:CalicoStub.Releases += [pscustomobject]@{
    tag_name = $Tag; draft = [bool]$Draft; prerelease = [bool]$Prerelease
    assets = @(
      [pscustomobject]@{ name = $AssetName; browser_download_url = $assetUrl },
      [pscustomobject]@{ name = 'checksums.txt'; browser_download_url = $sumsUrl }
    )
  }
}

function Reset-Case {
  param([string]$Name)
  $script:Case = $Name
  $script:CaseNo++
  $h = Join-Path $Sandbox ("home-$($script:CaseNo)")
  New-Item -ItemType Directory -Force -Path $h | Out-Null
  foreach ($n in $EnvNames) { if ($n -ne 'PATH') { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue } }
  $env:USERPROFILE = $h
  $env:HOME = $h
  $env:CALICO_PLATFORM = 'win32-x64'
  $env:PATH = "$StubBin;$env:SystemRoot\System32;$env:SystemRoot"
  $env:CALICO_TEST_GH_LOG = Join-Path $h 'gh.log'
  $env:CALICO_TEST_GH_RC = '0'
  $env:CALICO_TEST_GH_AUTH_RC = '0'
  $script:H = $h
  $script:Bin = Join-Path $h '.local\bin'
  $script:L = Join-Path $script:Bin 'calico-claude.exe'
  $script:State = Join-Path $h '.claude\calico'
  $script:Record = Join-Path $script:State 'installed-tag'
  $script:Log = Join-Path $script:State 'update.log'
  $script:Versions = Join-Path $h '.local\share\calico-claude\versions'
  New-Stub
}

function Set-Installed {
  param([string]$Output, [string]$Tag, [switch]$NoRecord, [string]$RecordHash = '')
  New-Fake $script:L $Output | Out-Null
  if ($NoRecord) { return }
  if (-not $RecordHash) { $RecordHash = Get-Sha $script:L }
  New-Item -ItemType Directory -Force -Path $script:State | Out-Null
  [IO.File]::WriteAllText($script:Record, "tag=$Tag`r`nsha256=$RecordHash`r`n")
}

function Invoke-Up {
  param([string]$Mode, [string]$PinTag = '')
  $global:LASTEXITCODE = 0
  & $UpdateScript -Mode $Mode -PinTag $PinTag *> $null
  return $LASTEXITCODE
}

function Read-Text { param([string]$Path) if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' } }
function Read-Log { Read-Text $script:Log }
function Read-GhLog { Read-Text $env:CALICO_TEST_GH_LOG }
function Get-RecordTag { $t = Read-Text $script:Record; if ($t -match 'tag=(\S+)') { $Matches[1] } else { '' } }
function Get-BinNames {
  if (-not (Test-Path -LiteralPath $script:Bin)) { return @() }
  return @(Get-ChildItem -LiteralPath $script:Bin -File | ForEach-Object { $_.Name } | Sort-Object)
}

function Start-Holder {
  param([string]$Exe)
  $p = Microsoft.PowerShell.Management\Start-Process -FilePath $Exe -ArgumentList '--hold', '90' -PassThru -WindowStyle Hidden
  [void]$Holders.Add($p)
  Start-Sleep -Milliseconds 700
  return $p
}

function Stop-Holder {
  param($Process)
  if (-not $Process.HasExited) { $Process.Kill() }
  $Process.WaitForExit()
}

function Test-FileLocked {
  param([string]$Path)
  try { $s = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None'); $s.Dispose(); return $false } catch { return $true }
}

try {
  New-Item -ItemType Directory -Force -Path $StubBin | Out-Null

  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found under $env:WINDIR\Microsoft.NET; cannot build the stand-in exe" }
  $cs = Join-Path $Sandbox 'fake.cs'
  [IO.File]::WriteAllText($cs, @'
using System; using System.IO; using System.Text; using System.Threading;
class P { static int Main(string[] a) {
  if (a.Length > 1 && a[0] == "--hold") { Thread.Sleep(int.Parse(a[1]) * 1000); return 0; }
  string s = Encoding.GetEncoding(28591).GetString(File.ReadAllBytes(System.Reflection.Assembly.GetExecutingAssembly().Location));
  string m = "@@CALICO" + "-OUT@@";
  int i = s.LastIndexOf(m);
  if (i < 0) return 3;
  Console.Write(s.Substring(i + m.Length).Replace("\\n", "\n"));
  return 0; } }
'@)
  $baseExe = Join-Path $Sandbox 'fake-base.exe'
  & $csc /nologo /out:$baseExe $cs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'csc failed to build the stand-in exe' }
  $FakeBase = [IO.File]::ReadAllBytes($baseExe)

  [IO.File]::WriteAllText((Join-Path $StubBin 'gh.cmd'), (@(
    '@echo off',
    'if not defined CALICO_TEST_GH_LOG goto dispatch',
    '>>"%CALICO_TEST_GH_LOG%" echo ARGV %*',
    '>>"%CALICO_TEST_GH_LOG%" echo ENV GH_REPO=[%GH_REPO%] GH_HOST=[%GH_HOST%]',
    ':dispatch',
    'if "%~1"=="auth" goto auth',
    'if "%~1"=="attestation" goto attest',
    'exit /b 9',
    ':auth',
    'if "%~2"=="token" goto token',
    'exit /b %CALICO_TEST_GH_AUTH_RC%',
    ':token',
    'if not defined CALICO_TEST_GH_TOKEN exit /b 1',
    'echo %CALICO_TEST_GH_TOKEN%',
    'exit /b 0',
    ':attest',
    'if defined CALICO_TEST_GH_STDERR echo %CALICO_TEST_GH_STDERR% 1>&2',
    'exit /b %CALICO_TEST_GH_RC%'
  ) -join "`r`n") + "`r`n")

  $Out279 = '2.1.279 (Claude Code)\n(patched)\n'
  $Out280 = '2.1.280 (Claude Code)\n(patched)\n'
  $Art280 = New-Fake (Join-Path $Sandbox 'art-280.exe') $Out280
  $Art280b = New-Fake (Join-Path $Sandbox 'art-280b.exe') ($Out280 + 'rebuild')
  $Art281 = New-Fake (Join-Path $Sandbox 'art-281.exe') '2.1.281 (Claude Code)\n(patched)\n'
  $Tag280 = 'v2.1.280-win32-x64'

  # --- First install, token handling, attestation argv ------------------------
  Reset-Case 'first install'
  $env:GITHUB_TOKEN = $Sentinel
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'launcher is the artifact' ((Test-Path -LiteralPath $L) -and (Get-Sha $L) -eq (Get-Sha $Art280))
  Check 'record names the tag' ((Get-RecordTag) -eq $Tag280) (Get-RecordTag)
  Check 'record holds the launcher hash' ((Read-Text $Record).Contains("sha256=$(Get-Sha $Art280)"))
  Check 'a copy is kept under versions' (Test-Path -LiteralPath (Join-Path $Versions '2.1.280'))
  Check 'only the launcher is left in bin' (((Get-BinNames) -join ',') -eq 'calico-claude.exe') ((Get-BinNames) -join ',')
  Check 'API call carried the token' ($CalicoStub.Api.Count -eq 1 -and $CalicoStub.Api[0].Auth -eq "Bearer $Sentinel")
  Check 'downloads carried no token' ($CalicoStub.Downloads.Count -eq 2 -and @($CalicoStub.Downloads | Where-Object { $_.Auth }).Count -eq 0)
  Check 'token absent from the log' (-not (Read-Log).Contains($Sentinel))
  Check 'token absent from every gh argv' (-not (Read-GhLog).Contains($Sentinel))
  $gh = Read-GhLog
  Check 'attestation pins --repo' ($gh.Contains('--repo Nanako0129/calico-claude ')) $gh
  Check 'attestation pins --signer-workflow' ($gh.Contains('--signer-workflow Nanako0129/calico-claude/.github/workflows/patch-claude.yml')) $gh
  Check 'attestation pins --source-ref' ($gh.Contains('--source-ref refs/heads/main')) $gh
  Check 'attestation verified in log' ((Read-Log).Contains('Attestation verified'))

  $script:Case = 'rerun up to date'
  New-Stub
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'nothing downloaded' ($CalicoStub.Downloads.Count -eq 0)
  Check 'reports up to date' ((Read-Log).Contains('is up to date'))

  # --- Token sources ----------------------------------------------------------
  Reset-Case 'token order'
  Add-Release $Tag280 $Art280
  $env:GITHUB_TOKEN = 'tok-github'; $env:GH_TOKEN = 'tok-gh'
  [void](Invoke-Up 'check')
  Remove-Item Env:GITHUB_TOKEN
  [void](Invoke-Up 'check')
  Remove-Item Env:GH_TOKEN
  $env:CALICO_TEST_GH_TOKEN = $Sentinel
  [void](Invoke-Up 'check')
  $auths = @($CalicoStub.Api | ForEach-Object { $_.Auth })
  Check 'GITHUB_TOKEN wins' ($auths[0] -eq 'Bearer tok-github') "$auths"
  Check 'GH_TOKEN next' ($auths[1] -eq 'Bearer tok-gh') "$auths"
  Check 'gh auth token last' ($auths[2] -eq "Bearer $Sentinel") "$auths"
  Check 'gh was asked, token not in its argv' ((Read-GhLog).Contains('ARGV auth token') -and -not (Read-GhLog).Contains($Sentinel))

  # --- Checksum and artifact gates ---------------------------------------------
  Reset-Case 'bad checksum'
  Add-Release $Tag280 $Art280 -Sums ('0' * 64 + "  $AssetName")
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'nothing installed' (-not (Test-Path -LiteralPath $L))
  Check 'bin left empty' ((Get-BinNames).Count -eq 0) ((Get-BinNames) -join ',')
  Check 'says checksum failed' ((Read-Log).Contains('Checksum verification FAILED'))

  # One decoy per run: each alone must be refused, so a pattern match that
  # accepts any one of them installs and fails here.
  foreach ($decoy in "x$AssetName", "$AssetName.bak", 'claudeXnative.windows.patched.exe') {
    Reset-Case "decoy checksum line '$decoy'"
    Add-Release $Tag280 $Art280 -Sums ("$((Get-Sha $Art280).ToLowerInvariant())  $decoy")
    $rc = Invoke-Up 'run'
    Check 'refused, nothing installed' ($rc -eq 1 -and -not (Test-Path -LiteralPath $L)) "rc=$rc"
    Check 'no entry found' ((Read-Log).Contains("0 entries for $AssetName"))
  }

  Reset-Case 'star-prefixed checksum name'
  Add-Release $Tag280 $Art280 -Sums ("$((Get-Sha $Art280).ToUpperInvariant()) *$AssetName")
  $rc = Invoke-Up 'run'
  Check 'exit 0, installed' ($rc -eq 0 -and (Test-Path -LiteralPath $L)) "rc=$rc"

  Reset-Case 'wrong version'
  Add-Release $Tag280 (New-Fake (Join-Path $H 'a.exe') '2.1.2800 (Claude Code)\n(patched)\n')
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'nothing installed' (-not (Test-Path -LiteralPath $L))
  Check 'says expected version' ((Read-Log).Contains('expected 2.1.280 and (patched)'))

  Reset-Case 'missing (patched)'
  Add-Release $Tag280 (New-Fake (Join-Path $H 'a.exe') '2.1.280 (Claude Code)\n')
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'nothing installed' (-not (Test-Path -LiteralPath $L))

  # --- Release choice ---------------------------------------------------------
  Reset-Case 'prerelease skipped'
  Add-Release 'v2.1.281-win32-x64' $Art281 -Prerelease
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'installs the release, not the prerelease' ($rc -eq 0 -and (Get-RecordTag) -eq $Tag280) "rc=$rc tag=$(Get-RecordTag)"

  Reset-Case 'draft skipped'
  Add-Release 'v2.1.281-win32-x64' $Art281 -Draft
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'installs the release, not the draft' ($rc -eq 0 -and (Get-RecordTag) -eq $Tag280) "rc=$rc tag=$(Get-RecordTag)"

  Reset-Case 'installed newer than latest'
  Set-Installed '2.1.281 (Claude Code)\n(patched)\n' 'v2.1.281-win32-x64'
  $before = Get-Sha $L
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'warns' ((Read-Log).Contains('WARNING: installed 2.1.281 is newer than the latest release 2.1.280'))
  Check 'launcher unchanged' ((Get-Sha $L) -eq $before)

  Reset-Case 'pinned tag'
  Add-Release $Tag280 $Art280
  Add-Release "$Tag280-2" $Art280b
  $rc = Invoke-Up 'run' $Tag280
  Check 'installs the pinned tag' ($rc -eq 0 -and (Get-RecordTag) -eq $Tag280) "rc=$rc tag=$(Get-RecordTag)"
  New-Stub
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run' 'v9.9.9-win32-x64'
  Check 'unknown pinned tag fails' ($rc -eq 1) "rc=$rc"

  # --- Install record -----------------------------------------------------------
  Reset-Case 'record version mismatch'
  Set-Installed $Out280 'v2.1.279-win32-x64-5'
  Add-Release $Tag280 $Art280b
  $rc = Invoke-Up 'run'
  Check 'reinstalls the latest rebuild' ($rc -eq 0 -and (Get-RecordTag) -eq $Tag280 -and (Get-Sha $L) -eq (Get-Sha $Art280b)) "rc=$rc tag=$(Get-RecordTag)"

  Reset-Case 'record rank current'
  Set-Installed $Out280 "$Tag280-5"
  $before = Get-Sha $L
  Add-Release $Tag280 $Art280b
  $rc = Invoke-Up 'run'
  Check 'a matching record keeps its rank' ($rc -eq 0 -and (Get-Sha $L) -eq $before -and $CalicoStub.Downloads.Count -eq 0) "rc=$rc"

  Reset-Case 'launcher without record'
  Set-Installed $Out279 '' -NoRecord
  $before = Get-Sha $L
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'bytes unchanged' ((Get-Sha $L) -eq $before)
  Check 'nothing downloaded' ($CalicoStub.Downloads.Count -eq 0)

  Reset-Case 'launcher hash mismatch'
  Set-Installed $Out279 'v2.1.279-win32-x64' -RecordHash ('A' * 64)
  $before = Get-Sha $L
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'bytes unchanged' ((Get-Sha $L) -eq $before)
  Check 'nothing downloaded' ($CalicoStub.Downloads.Count -eq 0)

  # --- gh ---------------------------------------------------------------------
  Reset-Case 'gh exit 1, no stderr'
  $env:CALICO_TEST_GH_RC = '1'
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'rejected' ($rc -eq 1 -and -not (Test-Path -LiteralPath $L)) "rc=$rc"
  Check 'says attestation failed' ((Read-Log).Contains('Attestation verification FAILED'))

  Reset-Case 'gh exit 0 with stderr'
  $env:CALICO_TEST_GH_STDERR = 'notice: something on stderr'
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'accepted' ($rc -eq 0 -and (Test-Path -LiteralPath $L)) "rc=$rc"

  Reset-Case 'gh unknown flag'
  $env:CALICO_TEST_GH_RC = '1'
  $env:CALICO_TEST_GH_STDERR = 'unknown flag: --signer-workflow'
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'fails closed' ($rc -eq 1 -and -not (Test-Path -LiteralPath $L)) "rc=$rc"
  Check 'names the old gh' ((Read-Log).Contains('cannot pin the signing workflow and ref'))

  Reset-Case 'gh absent'
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'installs on checksum alone' ($rc -eq 0 -and (Test-Path -LiteralPath $L)) "rc=$rc"
  Check 'warns' ((Read-Log).Contains('WARNING: gh not found'))

  # --- Swap -------------------------------------------------------------------
  Reset-Case 'locked launcher'
  Set-Installed $Out279 'v2.1.279-win32-x64'
  $holder = Start-Holder $L
  Check 'stand-in holds the launcher' (Test-FileLocked $L)
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'launcher replaced' ((Get-Sha $L) -eq (Get-Sha $Art280))
  Check 'record at latest' ((Get-RecordTag) -eq $Tag280)
  $log = Read-Log
  Check 'first rename logged' ($log.Contains("Renamed $L -> $L.calico-old."))
  Check 'second rename logged' ($log -match [regex]::Escape("$L.calico-new.") + '\S+ -> ' + [regex]::Escape($L) + '\r?\n')
  $asides = @(Get-BinNames | Where-Object { $_.StartsWith('calico-claude.exe.calico-old.') })
  Check 'held aside left in place' ($asides.Count -eq 1 -and -not $holder.HasExited) ((Get-BinNames) -join ',')
  Stop-Holder $holder
  New-Stub
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'released aside swept on the next run' ($rc -eq 0 -and ((Get-BinNames) -join ',') -eq 'calico-claude.exe') ((Get-BinNames) -join ',')

  Reset-Case 'failed rename rolls back'
  Set-Installed $Out279 'v2.1.279-win32-x64'
  $before = Get-Sha $L
  $recordBefore = Read-Text $Record
  $CalicoStub.FailStagingRename = $true
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'original launcher restored' ((Test-Path -LiteralPath $L) -and (Get-Sha $L) -eq $before)
  Check 'record restored' ((Read-Text $Record) -eq $recordBefore)
  Check 'no staging or aside left' (((Get-BinNames) -join ',') -eq 'calico-claude.exe') ((Get-BinNames) -join ',')

  Reset-Case 'partial download'
  Set-Installed $Out279 'v2.1.279-win32-x64'
  $before = Get-Sha $L
  $CalicoStub.PartialAsset = $true
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 1' ($rc -eq 1) "rc=$rc"
  Check 'launcher untouched' ((Get-Sha $L) -eq $before)
  Check 'partial staging removed' (((Get-BinNames) -join ',') -eq 'calico-claude.exe') ((Get-BinNames) -join ',')

  # --- Mutex ------------------------------------------------------------------
  Reset-Case 'concurrent run'
  $ready = Join-Path $H 'mutex-ready'
  $code = "`$m = New-Object System.Threading.Mutex(`$false, 'Local\calico-claude-update'); [void]`$m.WaitOne(); [IO.File]::WriteAllText('$ready', 'x'); Start-Sleep -Seconds 90"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  $psExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $holder = Microsoft.PowerShell.Management\Start-Process -FilePath $psExe -ArgumentList "-NoProfile -NonInteractive -EncodedCommand $enc" -PassThru -WindowStyle Hidden
  [void]$Holders.Add($holder)
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $ready) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  Check 'holder took the mutex' (Test-Path -LiteralPath $ready)
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'blocked before any work' ($CalicoStub.Api.Count -eq 0 -and -not (Test-Path -LiteralPath $L))
  Check 'says another update runs' ((Read-Log).Contains('Another update is already in progress'))
  Stop-Holder $holder
  $rc = Invoke-Up 'run'
  Check 'abandoned mutex is taken over' ($rc -eq 0 -and (Test-Path -LiteralPath $L)) "rc=$rc"

  # --- Housekeeping -------------------------------------------------------------
  Reset-Case 'aside sweep'
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  [IO.File]::WriteAllText((Join-Path $Bin 'calico-claude.exe.calico-old.111'), 'old')
  [IO.File]::WriteAllText((Join-Path $Bin 'calico-claude.exe.calico-new.abc.exe'), 'stale')
  [IO.File]::WriteAllText((Join-Path $Bin 'claude.exe'), 'official')
  [IO.File]::WriteAllText((Join-Path $Bin 'claude.exe.calico-old.333'), 'official aside')
  $running = New-Fake (Join-Path $Bin 'held.exe') $Out279
  $holder = Start-Holder $running
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $running -Destination (Join-Path $Bin 'calico-claude.exe.calico-old.222')
  $rc = Invoke-Up 'run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'names the aside it left' ((Read-Log).Contains('Left calico-claude.exe.calico-old.222 in place'))
  Check 'only the in-use aside and unrelated files remain' (((Get-BinNames) -join ',') -eq 'calico-claude.exe.calico-old.222,claude.exe,claude.exe.calico-old.333') ((Get-BinNames) -join ',')
  Stop-Holder $holder

  Reset-Case 'prune versions'
  New-Item -ItemType Directory -Force -Path $Versions | Out-Null
  foreach ($i in 1..5) {
    $f = Join-Path $Versions "2.1.27$i"
    [IO.File]::WriteAllText($f, "$i")
    (Get-Item -LiteralPath $f).LastWriteTimeUtc = [DateTime]::UtcNow.AddDays(-10 + $i)
  }
  $rc = Invoke-Up 'run'
  $kept = @(Get-ChildItem -LiteralPath $Versions -File | ForEach-Object { $_.Name } | Sort-Object) -join ','
  Check 'keeps the newest 3' ($rc -eq 0 -and $kept -eq '2.1.273,2.1.274,2.1.275') "rc=$rc kept=$kept"
  Check 'names what it pruned' ((Read-Log).Contains('Pruned old version 2.1.271'))

  # --- Unattended settings -----------------------------------------------------
  Reset-Case 'unattended reads config'
  New-Item -ItemType Directory -Force -Path $State | Out-Null
  [IO.File]::WriteAllText((Join-Path $State 'config'), "# fork`r`nrepo=good-owner/good-repo`r`n")
  $env:CALICO_REPO = 'evil/evil'
  $env:GH_REPO = 'evil/ghrepo'
  $env:GH_HOST = 'evil.example'
  $env:CALICO_BIN_LINK = Join-Path $H 'elsewhere\calico-claude.exe'
  $env:CALICO_STATE_DIR = Join-Path $H 'evilstate'
  Add-Release $Tag280 $Art280
  $rc = Invoke-Up 'unattended-run'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'queried the configured repo' ($CalicoStub.Api.Count -eq 1 -and $CalicoStub.Api[0].Uri -eq 'https://api.github.com/repos/good-owner/good-repo/releases?per_page=100') "$($CalicoStub.Api[0].Uri)"
  $gh = Read-GhLog
  Check 'attested against the configured repo' ($gh.Contains('--repo good-owner/good-repo ')) $gh
  Check 'gh saw no GH_REPO/GH_HOST' ($gh.Contains('ENV GH_REPO=[] GH_HOST=[]') -and -not $gh.Contains('evil')) $gh
  Check 'installed at the USERPROFILE launcher' ((Test-Path -LiteralPath $L) -and -not (Test-Path -LiteralPath $env:CALICO_BIN_LINK) -and -not (Test-Path -LiteralPath $env:CALICO_STATE_DIR))

  Reset-Case 'unattended default repo'
  $env:CALICO_REPO = 'evil/evil'
  [void](Invoke-Up 'unattended-run')
  New-Item -ItemType Directory -Force -Path $State | Out-Null
  [IO.File]::WriteAllText((Join-Path $State 'config'), "repo=evil/evil/extra`r`n")
  [void](Invoke-Up 'unattended-run')
  [void](Invoke-Up 'run')
  $uris = @($CalicoStub.Api | ForEach-Object { $_.Uri })
  Check 'no config -> default repo' ($uris[0] -eq 'https://api.github.com/repos/Nanako0129/calico-claude/releases?per_page=100') "$uris"
  Check 'malformed config -> default repo' ($uris[1] -eq 'https://api.github.com/repos/Nanako0129/calico-claude/releases?per_page=100') "$uris"
  Check 'interactive run still honours CALICO_REPO' ($uris[2] -eq 'https://api.github.com/repos/evil/evil/releases?per_page=100') "$uris"

  Reset-Case 'PinTag outside run/force'
  Add-Release $Tag280 $Art280
  foreach ($m in 'hook', 'unattended-run', 'check') {
    $rc = Invoke-Up $m $Tag280
    Check "rejected in $m" ($rc -eq 2) "rc=$rc"
  }
  Check 'no API call, no child' ($CalicoStub.Api.Count -eq 0 -and $CalicoStub.Spawned.Count -eq 0)

  # --- Hook ---------------------------------------------------------------------
  Reset-Case 'hook'
  $env:GITHUB_TOKEN = $Sentinel
  $rc = Invoke-Up 'hook'
  Check 'exit 0' ($rc -eq 0) "rc=$rc"
  Check 'started one child' ($CalicoStub.Spawned.Count -eq 1)
  $cmd = "$($CalicoStub.Spawned[0])"
  Check 'child runs unattended-run' ($cmd.Contains('-Mode unattended-run') -and $cmd.Contains($UpdateScript)) $cmd
  Check 'token absent from the child command line' (-not $cmd.Contains($Sentinel)) $cmd
  Check 'did no work itself' ($CalicoStub.Api.Count -eq 0)
  Check 'stamped last-check' (Test-Path -LiteralPath (Join-Path $State 'last-check'))
  $rc = Invoke-Up 'hook'
  Check 'second hook is throttled' ($rc -eq 0 -and $CalicoStub.Spawned.Count -eq 1)
} catch {
  $Fail++
  Write-Host "FAIL $($script:Case): suite crashed: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  foreach ($p in $Holders) { try { if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() } } catch { } }
  foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $SavedEnv[$n]) }
  Remove-Variable -Name CalicoStub -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "passed $Pass failed $Fail"
if ($Fail -ne 0 -or $Pass -eq 0) { exit 1 }
exit 0
