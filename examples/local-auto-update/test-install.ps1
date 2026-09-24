<#
Offline suite for install-patched-claude.ps1 (the Windows bootstrapper). Runs
under PowerShell 7 and Windows PowerShell 5.1, on Windows only.

  pwsh -NoProfile -ExecutionPolicy Bypass -File test-install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File test-install.ps1
  ... -InstallerScript <path>   test another copy (used for mutation runs)
  ... -SymlinkHome <dir>        see the symlink case below

Run it from a normal, non-elevated session: the installer refuses an
administrator token. Run elevated, the suite checks only that refusal, against
the real token.

Every case runs the real installer the way the README runs it, as
`& ([scriptblock]::Create(<text>))`, with USERPROFILE and HOME pointing into a
sandbox under %TEMP%. The network is stubbed by shadowing Invoke-RestMethod and
Invoke-WebRequest with functions (the installer runs in a child scope of this
script, and a function wins over a cmdlet of the same name). The update.ps1 it
downloads is a stand-in that only writes under the sandbox, and does nothing at
all unless USERPROFILE is inside it. gh and claude are .cmd stubs on PATH. The
scheduled task is real, but registered under a test folder
(CALICO_TEST_TASK_PATH), first due an hour out, and deleted at the end.

Pure ASCII, like the installer, for Windows PowerShell 5.1.
#>
param([string]$InstallerScript = '', [string]$SymlinkHome = '')

$ErrorActionPreference = 'Stop'
if (-not $InstallerScript) { $InstallerScript = Join-Path $PSScriptRoot '..\..\install-patched-claude.ps1' }
$InstallerScript = (Resolve-Path -LiteralPath $InstallerScript).Path
$InstallerText = [IO.File]::ReadAllText($InstallerScript)

$FakeSha = '0123456789abcdef0123456789abcdef01234567'
$Me = [Security.Principal.WindowsIdentity]::GetCurrent()
$Sid = $Me.User.Value
$TestTaskPath = '\calico-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '\'
$TestTaskName = "auto-update-$Sid"
$Sandbox = Join-Path ([IO.Path]::GetTempPath()) ('calico-install-test-' + [guid]::NewGuid().ToString('N'))
$StubBin = Join-Path $Sandbox 'stub-bin'
$ClaudeBin = Join-Path $Sandbox 'claude-bin'
$UpdaterLog = Join-Path $Sandbox 'updater.log'
$FakeUpdater = Join-Path $Sandbox 'fake-update.ps1'
$Fx = Join-Path $Sandbox 'fixtures'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$EnvNames = @('USERPROFILE', 'HOME', 'PATH', 'OS', 'GITHUB_TOKEN', 'GH_TOKEN', 'PATCH_CLAUDE_REPO', 'CALICO_REPO',
  'CALICO_SOURCE_REF', 'CALICO_BIN_LINK', 'CALICO_VERSIONS_DIR', 'CALICO_STATE_DIR', 'CALICO_TEST_TASK_PATH',
  'CALICO_TEST_ASSUME_ELEVATED', 'CALICO_TEST_GH_RC', 'CALICO_TEST_GH_OUT', 'FAKE_UPDATER_RC', 'FAKE_UPDATER_NOLINK')
$SavedEnv = @{}
foreach ($n in $EnvNames) { $SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n) }
$Pass = 0
$Fail = 0
$Skip = 0
$CaseNo = 0
$Out = ''

function Check {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) { $script:Pass++; Write-Host "ok   $Name" }
  else { $script:Fail++; Write-Host "FAIL $Name $Detail" }
}
function Same { param([string]$Name, $Expected, $Actual) Check $Name ("$Expected" -ceq "$Actual") "(expected [$Expected], got [$Actual])" }
function Has { param([string]$Name, [string]$Needle) Check $Name ($script:Out.Contains($Needle)) "(no [$Needle] in: $($script:Out))" }

# --- stubs (state in $global: because they run in the installer's scope) ------
$global:T = @{ Requests = New-Object System.Collections.ArrayList; ShaAnswer = $FakeSha; Updater = $FakeUpdater }

function Invoke-RestMethod {
  param([string]$Uri, [hashtable]$Headers)
  [void]$global:T.Requests.Add([pscustomobject]@{ Uri = $Uri; Auth = $Headers['Authorization']; Accept = $Headers['Accept'] })
  if ($Uri -like 'https://api.github.com/repos/*/commits/*') { return $global:T.ShaAnswer }
  throw "404 Not Found: $Uri"
}

function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, $Headers, [switch]$UseBasicParsing)
  $auth = $null
  if ($Headers) { $auth = $Headers['Authorization'] }
  [void]$global:T.Requests.Add([pscustomobject]@{ Uri = $Uri; Auth = $auth; Accept = '' })
  if ($Uri -like 'https://raw.githubusercontent.com/*/examples/local-auto-update/update.ps1') {
    [IO.File]::Copy($global:T.Updater, $OutFile, $true)
    return
  }
  throw "404 Not Found: $Uri"
}

# --- harness ------------------------------------------------------------------
function Reset-Case {
  param([string]$Name)
  $script:CaseNo++
  Write-Host "--- $Name"
  $h = Join-Path $Sandbox "home-$($script:CaseNo)"
  New-Item -ItemType Directory -Force -Path (Join-Path $h '.claude') | Out-Null
  foreach ($n in $EnvNames) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue }
  $env:OS = 'Windows_NT'
  $env:USERPROFILE = $h
  $env:HOME = $h
  $env:PATH = "$StubBin;$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  $env:CALICO_TEST_TASK_PATH = $TestTaskPath
  $env:CALICO_TEST_GH_RC = '1'
  $global:T.Requests.Clear()
  $global:T.ShaAnswer = $FakeSha
  $global:T.Updater = $FakeUpdater
  [IO.File]::WriteAllText($UpdaterLog, '')
  Remove-TestTask
  $script:H = $h
  $script:SettingsPath = Join-Path $h '.claude\settings.json'
  $script:State = Join-Path $h '.claude\calico'
  $script:LauncherPath = Join-Path $h '.local\bin\calico-claude.exe'
  $script:HookCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}/.claude/calico/update.ps1" -Mode hook' -f ($h -replace '\\', '/')
}

# Runs the installer as the README does. Returns its $LASTEXITCODE; its output
# (Write-Host, and the updater's, which it relays) goes to $script:Out.
function Invoke-Installer {
  param([switch]$Uninstall, [hashtable]$Env = @{})
  $saved = @{}
  foreach ($k in $Env.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $Env[$k]) }
  $global:LASTEXITCODE = 99
  try {
    $sb = [scriptblock]::Create($InstallerText)
    if ($Uninstall) { $lines = & $sb -Uninstall *>&1 } else { $lines = & $sb *>&1 }
  } finally {
    foreach ($k in $Env.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
  $script:Out = (@($lines) | ForEach-Object { "$_" }) -join "`n"
  return $global:LASTEXITCODE
}

function Read-Text { param([string]$Path) if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' } }
function Get-Sha { param([string]$Path) (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Test-SameFile { param([string]$A, [string]$B) (Test-Path -LiteralPath $A) -and (Test-Path -LiteralPath $B) -and (Get-Sha $A) -eq (Get-Sha $B) }
function Get-ApiCount { @($global:T.Requests | Where-Object { $_.Uri -like 'https://api.github.com/*' }).Count }
function Get-TempLeftovers { @(Get-ChildItem -LiteralPath (Join-Path $script:H '.claude') -Force | Where-Object { $_.Name -like '.settings.json.calico-*' }).Count }
# Existence through the COM API: only "not found" (0x80070002) means absent;
# any other error throws. An empty answer from Get-ScheduledTask
# -ErrorAction SilentlyContinue would pass "the task is gone" for any reason.
function Test-TaskExists {
  param([string]$Name = $TestTaskName)
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  try { [void]$service.GetFolder($TestTaskPath.TrimEnd('\')).GetTask($Name); return $true }
  catch { if ($_.Exception.HResult -eq -2147024894) { return $false }; throw }
}
function Get-TestTask { if (Test-TaskExists) { Get-ScheduledTask -TaskPath $TestTaskPath -TaskName $TestTaskName } }
# The names of the tasks in the test folder, also through COM (1 = include hidden).
function Get-TestTaskNames {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  try { $folder = $service.GetFolder($TestTaskPath.TrimEnd('\')) }
  catch { if ($_.Exception.HResult -eq -2147024894) { return @() }; throw }
  return @($folder.GetTasks(1) | ForEach-Object { $_.Name })
}
# Between cases only. With eight suites registering tasks at once (mutation
# runs), Unregister-ScheduledTask failed now and then and crashed the suite;
# a run on its own never did. So it is retried a few times.
function Remove-TestTask {
  foreach ($name in @(Get-TestTaskNames)) {
    for ($try = 1; ; $try++) {
      try { Unregister-ScheduledTask -TaskPath $TestTaskPath -TaskName $name -Confirm:$false; break }
      catch { if ($try -ge 5) { throw }; Start-Sleep -Seconds 1 }
    }
  }
}
function Test-TaskFolder {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  try { [void]$service.GetFolder($TestTaskPath.TrimEnd('\')); return $true }
  catch { if ($_.Exception.HResult -eq -2147024894) { return $false }; throw }
}

# --- the comparison contract ----------------------------------------------------
# Independent of the installer's own parser: ConvertFrom-Json of this shell. A
# missing or blank file reads as {}. Both sides drop every SessionStart hook
# whose command references .claude/calico/update. (and any group that removal
# empties); a SessionStart array, and then a hooks object, that the removal
# empties is dropped too unless the original input had it with content of its
# own. The rest is compared as parsed values, key order and string values
# included. The fixtures it reads avoid what ConvertFrom-Json itself cannot
# represent (an empty key, keys differing in case, 5.1's "\/Date()\/"); those
# are checked byte for byte instead.
$CalicoMarker = '.claude/calico/update.'

function ConvertTo-Node {
  param($V)
  if ($null -eq $V) { return @{ T = 'x'; S = 'null' } }
  if ($V -is [string]) { return @{ T = 'x'; S = 's:' + $V } }
  if ($V -is [bool]) { return @{ T = 'x'; S = 'b:' + $V } }
  if ($V -is [System.Management.Automation.PSCustomObject]) {
    $n = @{ T = 'o'; K = New-Object System.Collections.Generic.List[string]; V = New-Object System.Collections.Generic.List[object] }
    foreach ($p in $V.PSObject.Properties) { $n.K.Add($p.Name); $n.V.Add((ConvertTo-Node $p.Value)) }
    return $n
  }
  if ($V -is [array]) {
    $n = @{ T = 'a'; V = New-Object System.Collections.Generic.List[object] }
    foreach ($e in $V) { $n.V.Add((ConvertTo-Node $e)) }
    return $n
  }
  return @{ T = 'x'; S = 'n:' + [string]$V }
}

function Read-Node {
  param([string]$Path)
  $text = ''
  if (Test-Path -LiteralPath $Path) { $text = [IO.File]::ReadAllText($Path) }
  if (-not $text.Trim()) { return @{ T = 'o'; K = New-Object System.Collections.Generic.List[string]; V = New-Object System.Collections.Generic.List[object] } }
  if ($PSVersionTable.PSVersion.Major -ge 7) { $v = ConvertFrom-Json -InputObject $text -DateKind String -Depth 1024 -NoEnumerate }
  else { $v = ConvertFrom-Json -InputObject $text }
  return (ConvertTo-Node $v)
}

function Get-Member2 { param($Node, [string]$Key) if ($Node.T -ne 'o') { return $null }; $i = $Node.K.IndexOf($Key); if ($i -lt 0) { return $null }; return $Node.V[$i] }
function Remove-Member2 { param($Node, [string]$Key) $i = $Node.K.IndexOf($Key); $Node.K.RemoveAt($i); $Node.V.RemoveAt($i) }
function Test-CalicoNode { param($H) $c = Get-Member2 $H 'command'; return ($null -ne $c -and $c.T -eq 'x' -and $c.S.StartsWith('s:') -and $c.S.Contains($CalicoMarker)) }

function Format-Node {
  param($N)
  if ($N.T -eq 'x') { return $N.S }
  # Loops, not @($N.V): @() over a List[object] throws "Argument types do not
  # match" on both 5.1 and 7 (measured).
  if ($N.T -eq 'a') { $items = foreach ($e in $N.V) { Format-Node $e }; return '[' + (@($items) -join ',') + ']' }
  $parts = for ($i = 0; $i -lt $N.K.Count; $i++) { 'k' + $N.K[$i].Length + ':' + $N.K[$i] + '=' + (Format-Node $N.V[$i]) }
  return '{' + (@($parts) -join ',') + '}'
}

# Returns @(ssEmptied, hooksEmptied) and strips $N in place.
function Remove-CalicoNodes {
  param($N)
  $hooks = Get-Member2 $N 'hooks'
  $ss = Get-Member2 $hooks 'SessionStart'
  if ($null -eq $hooks -or $hooks.T -ne 'o' -or $null -eq $ss -or $ss.T -ne 'a') { return @($false, $false) }
  $before = $ss.V.Count
  $kept = New-Object System.Collections.Generic.List[object]
  foreach ($g in $ss.V) {
    $inner = Get-Member2 $g 'hooks'
    if ($null -ne $inner -and $inner.T -eq 'a') {
      $left = New-Object System.Collections.Generic.List[object]
      foreach ($h in $inner.V) { if (-not (Test-CalicoNode $h)) { $left.Add($h) } }
      if ($left.Count -ne $inner.V.Count -and $left.Count -eq 0) { continue }
      $inner.V = $left
    }
    $kept.Add($g)
  }
  $ss.V = $kept
  $ssEmptied = ($before -gt 0 -and $kept.Count -eq 0)
  return @($ssEmptied, ($ssEmptied -and $hooks.K.Count -eq 1))
}

function Get-Normalised {
  param([string]$Path, [string]$OriginalPath)
  $y = Read-Node $Path
  $r = Remove-CalicoNodes $y
  $o = Read-Node $OriginalPath
  $oHooks = Get-Member2 $o 'hooks'
  $oHasSs = ($null -ne $oHooks -and $oHooks.T -eq 'o' -and $oHooks.K.Contains('SessionStart'))
  $or = Remove-CalicoNodes (Read-Node $OriginalPath)
  if ($r[0] -and (-not $oHasSs -or $or[0])) {
    $yHooks = Get-Member2 $y 'hooks'
    Remove-Member2 $yHooks 'SessionStart'
    if ($yHooks.K.Count -eq 0 -and ($null -eq $oHooks -or $or[1])) { Remove-Member2 $y 'hooks' }
  }
  return (Format-Node $y)
}

# A file that does not parse is an answer the caller's check fails on, not a
# crash of the suite: a crash reaches no verdict.
function Compare-Contract {
  param([string]$Original, [string]$Other)
  try { $same = (Get-Normalised $Original $Original) -ceq (Get-Normalised $Other $Original) }
  catch { return "unparsable: $($_.Exception.Message)" }
  if ($same) { return 'equal' }
  return 'unequal'
}

# How many hook entries reference the updater, and the first one's command.
function Get-CalicoHooks {
  param([string]$Path)
  $cmds = @()
  try { $root = Read-Node $Path } catch { return "unparsable: $($_.Exception.Message)" }
  $ss = Get-Member2 (Get-Member2 $root 'hooks') 'SessionStart'
  if ($null -ne $ss -and $ss.T -eq 'a') {
    foreach ($g in $ss.V) {
      $inner = Get-Member2 $g 'hooks'
      if ($null -ne $inner -and $inner.T -eq 'a') {
        foreach ($h in $inner.V) { if (Test-CalicoNode $h) { $cmds += (Get-Member2 $h 'command').S.Substring(2) } }
      }
    }
  }
  $first = if ($cmds.Count) { $cmds[0] } else { '' }
  return "$($cmds.Count)|$first"
}

function Test-OwnerOnlyAcl {
  param([string]$Path)
  $acl = Get-Acl -LiteralPath $Path
  $rules = @($acl.Access)
  return ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and
    $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $Sid -and
    $rules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
    $rules[0].AccessControlType -eq 'Allow' -and -not $rules[0].IsInherited)
}

function Write-Fixture { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, $Utf8) }
function U { param([int[]]$Codes) -join ($Codes | ForEach-Object { [char]::ConvertFromUtf32($_) }) }

try {
  # --- elevated: only the refusal, against the real token ------------------------
  if (([Security.Principal.WindowsPrincipal]$Me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    New-Item -ItemType Directory -Force -Path $Sandbox | Out-Null
    Write-Host 'Running elevated: checking only that the installer refuses this token.'
    foreach ($mode in 'install', 'uninstall') {
      Reset-Case "elevated $mode"
      $rc = if ($mode -eq 'install') { Invoke-Installer } else { Invoke-Installer -Uninstall }
      Same "elevated ${mode}: refused" 1 $rc
      Has "elevated ${mode}: says why" 'Do not run this installer as administrator'
      Same "elevated ${mode}: nothing fetched" 0 $global:T.Requests.Count
      Same "elevated ${mode}: nothing written" '.claude' ((@(Get-ChildItem -LiteralPath $H -Force) | ForEach-Object { $_.Name }) -join ',')
      Same "elevated ${mode}: .claude still empty" 0 @(Get-ChildItem -LiteralPath (Join-Path $H '.claude') -Force).Count
      Check "elevated ${mode}: no task" ($null -eq (Get-TestTask))
    }
    return  # the summary and exit code are in finally
  }

  New-Item -ItemType Directory -Force -Path $StubBin, $ClaudeBin, $Fx | Out-Null
  [IO.File]::WriteAllText((Join-Path $StubBin 'gh.cmd'), (@(
    '@echo off',
    'if not "%~1"=="auth" exit /b 9',
    'if not "%~2"=="token" exit /b 9',
    'if defined CALICO_TEST_GH_OUT echo %CALICO_TEST_GH_OUT%',
    'exit /b %CALICO_TEST_GH_RC%'
  ) -join "`r`n") + "`r`n")

  # Served as update.ps1. Records how it was called, then does what -Mode force
  # does to the filesystem: a kept build, the launcher, and the install record.
  # The only profiles it will write into: the sandbox, and -SymlinkHome.
  $roots = (@($Sandbox, $SymlinkHome) | Where-Object { $_ } | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ', '
  [IO.File]::WriteAllText($FakeUpdater, @"
param([string]`$Mode)
if (-not (@($roots) | Where-Object { "`$env:USERPROFILE".StartsWith(`$_, [StringComparison]::OrdinalIgnoreCase) })) { exit 0 }
function Show([string]`$Name) { `$v = [Environment]::GetEnvironmentVariable(`$Name); if (`$v) { `$v } else { 'unset' } }
Add-Content -LiteralPath '$($UpdaterLog.Replace("'", "''"))' -Value ('{0}|repo={1}|link={2}|state={3}|versions={4}' -f `$Mode, (Show 'CALICO_REPO'), (Show 'CALICO_BIN_LINK'), (Show 'CALICO_STATE_DIR'), (Show 'CALICO_VERSIONS_DIR'))
Write-Host 'fake updater ran'
if (`$env:FAKE_UPDATER_RC -and `$env:FAKE_UPDATER_RC -ne '0') { exit [int]`$env:FAKE_UPDATER_RC }
if (`$env:FAKE_UPDATER_NOLINK) { exit 0 }
`$versions = Join-Path `$env:USERPROFILE '.local\share\calico-claude\versions'
`$bin = Join-Path `$env:USERPROFILE '.local\bin'
`$state = Join-Path `$env:USERPROFILE '.claude\calico'
New-Item -ItemType Directory -Force -Path `$versions, `$bin, `$state | Out-Null
[IO.File]::WriteAllText((Join-Path `$versions '9.9.9'), 'fake build 9.9.9')
[IO.File]::WriteAllText((Join-Path `$bin 'calico-claude.exe'), 'fake build 9.9.9')
`$sha = (Get-FileHash -LiteralPath (Join-Path `$bin 'calico-claude.exe') -Algorithm SHA256).Hash
[IO.File]::WriteAllText((Join-Path `$state 'installed-tag'), "tag=v9.9.9-win32-x64``r``nsha256=`$sha``r``n")
exit 0
"@)

  # --- fixtures -----------------------------------------------------------------
  $nonAscii = (U 0x65E5, 0x672C, 0x8A9E) + ' ' + (U 0x2713) + ' caf' + (U 0xE9) + ' ' + (U 0x2014) + ' na' + (U 0xEF) + 've ' + (U 0x1F600)
  $kido = 'echo ' + (U 0x8D77, 0x52D5)
  $deep = '{"a": ' * 8 + '[1, 2.5, {"g": null, "h": [true, false]}]' + '}' * 8
  Write-Fixture (Join-Path $Fx 'no-hooks.json') '{"model": "opus", "permissions": {"allow": ["Bash(ls)"]}, "env": {"A": "1"}}'
  Write-Fixture (Join-Path $Fx 'unrelated.json') @"
{
  "zeta": "$nonAscii",
  "stamp": "2026-09-24T10:00:00Z",
  "day": "2026-09-24",
  "hooks": {
    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo pre"}]}],
    "SessionStart": [
      {"matcher": "startup", "hooks": [{"type": "command", "command": "$kido"}]},
      {"hooks": [{"type": "command", "command": "C:/bin/other-hook.exe", "timeout": 5}]}
    ],
    "Stop": []
  },
  "1": "one",
  "0": "zero",
  "deep": $deep,
  "nums": [1.0, 1e5, -0, 0.1, 12345678901234567890],
  "alpha": 1
}
"@
  Write-Fixture (Join-Path $Fx 'stale.json') @'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "startup", "hooks": [
        {"type": "command", "command": "echo before"},
        {"type": "command", "command": "powershell -File C:/Users/old/.claude/calico/update.ps1 -Mode hook", "timeout": 10, "async": true},
        {"type": "command", "command": "echo after"}]},
      {"hooks": [{"type": "command", "command": "echo unrelated"}]},
      {"hooks": [{"type": "command", "command": "/bin/bash \"/old/home/.claude/calico/update.sh\" --hook"}]}
    ]
  },
  "theme": "dark"
}
'@
  Write-Fixture (Join-Path $Fx 'empty.json') ''
  Write-Fixture (Join-Path $Fx 'braces.json') '{}'
  # The same values as unrelated.json, indented and spaced differently.
  Write-Fixture (Join-Path $Fx 'reindented.json') ((Read-Text (Join-Path $Fx 'unrelated.json')) -replace '\r?\n', "`r`n`t " -replace ': ', " :   ")
  # One unrelated hook's command string changed.
  Write-Fixture (Join-Path $Fx 'changed.json') ((Read-Text (Join-Path $Fx 'unrelated.json')).Replace($kido, "$kido!"))
  # The same members in another order.
  Write-Fixture (Join-Path $Fx 'reordered.json') ((Read-Text (Join-Path $Fx 'unrelated.json')) -replace ',\s*"alpha": 1', '' -replace '^\{', '{"alpha": 1,')
  $missing = Join-Path $Fx 'does-not-exist.json'

  # --- 0. the contract itself ---------------------------------------------------
  Same 'contract: an empty file equals {}' 'equal' (Compare-Contract (Join-Path $Fx 'empty.json') (Join-Path $Fx 'braces.json'))
  Same 'contract: a missing file equals {}' 'equal' (Compare-Contract $missing (Join-Path $Fx 'braces.json'))
  Same 'contract: whitespace and indentation alone compare equal' 'equal' (Compare-Contract (Join-Path $Fx 'unrelated.json') (Join-Path $Fx 'reindented.json'))
  Same 'contract: a changed unrelated hook string compares unequal' 'unequal' (Compare-Contract (Join-Path $Fx 'unrelated.json') (Join-Path $Fx 'changed.json'))
  Same 'contract: reordered keys compare unequal' 'unequal' (Compare-Contract (Join-Path $Fx 'unrelated.json') (Join-Path $Fx 'reordered.json'))

  # --- 1. refusals ----------------------------------------------------------------
  foreach ($mode in 'install', 'uninstall') {
    Reset-Case "elevated (injected) $mode"
    $rc = if ($mode -eq 'install') { Invoke-Installer -Env @{ CALICO_TEST_ASSUME_ELEVATED = '1' } } else { Invoke-Installer -Uninstall -Env @{ CALICO_TEST_ASSUME_ELEVATED = '1' } }
    Same "elevated ${mode}: refused with a non-zero exit" 1 $rc
    Has "elevated ${mode}: says why" 'Do not run this installer as administrator'
    Same "elevated ${mode}: nothing fetched" 0 $global:T.Requests.Count
    Same "elevated ${mode}: nothing written" 0 @(Get-ChildItem -LiteralPath (Join-Path $H '.claude') -Force).Count
    Check "elevated ${mode}: no task" ($null -eq (Get-TestTask))
  }

  Reset-Case 'not Windows'
  $rc = Invoke-Installer -Env @{ OS = $null }
  Same 'off Windows: refused' 1 $rc
  Has 'off Windows: points to the shell installer' 'install-patched-claude.sh'
  Same 'off Windows: nothing fetched' 0 $global:T.Requests.Count

  foreach ($bad in @(@{ CALICO_SOURCE_REF = 'main;x' }, @{ CALICO_REPO = 'evil/repo;rm' }, @{ CALICO_TEST_TASK_PATH = '\..\escape\' }, @{ USERPROFILE = 'relative\home' })) {
    $label = @($bad.Keys)[0]
    Reset-Case "invalid $label"
    $rc = Invoke-Installer -Env $bad
    Same "invalid ${label}: refused" 1 $rc
    Same "invalid ${label}: nothing fetched" 0 $global:T.Requests.Count
    Same "invalid ${label}: nothing written" 0 @(Get-ChildItem -LiteralPath (Join-Path $H '.claude') -Force).Count
  }

  # USERPROFILE goes into the hook command inside double quotes, run by Git Bash.
  foreach ($odd in 'a$b', 'a`b') {
    Reset-Case "USERPROFILE containing $($odd.Substring(1, 1))"
    $home2 = Join-Path $Sandbox "odd-$($script:CaseNo)\$odd"
    [void][IO.Directory]::CreateDirectory($home2)
    $rc = Invoke-Installer -Env @{ USERPROFILE = $home2 }
    Same "USERPROFILE with $($odd.Substring(1, 1)): refused" 1 $rc
    Check "USERPROFILE with $($odd.Substring(1, 1)): nothing written or fetched" (@(Get-ChildItem -LiteralPath $home2 -Force).Count -eq 0 -and $global:T.Requests.Count -eq 0)
  }

  # A file run as a script (-File) reports failure as its process exit code.
  # The child process has none of this suite's stubs, so it is handed an input
  # the installer refuses before any request, and one that still writes
  # nothing in a mutant without that check (GitHub rejects the ref).
  Reset-Case 'run as a file'
  $env:CALICO_SOURCE_REF = 'bad;ref'
  $psExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $InstallerScript *> $null
  $fileRc = $LASTEXITCODE
  Remove-Item Env:CALICO_SOURCE_REF
  Same 'run with -File: a refusal exits 1' 1 $fileRc
  Same 'run with -File: nothing written' 0 @(Get-ChildItem -LiteralPath (Join-Path $H '.claude') -Force).Count

  # --- 2. a fresh install -----------------------------------------------------------
  Reset-Case 'fresh install'
  $officialExe = Join-Path $H '.local\bin\claude.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path $officialExe) | Out-Null
  [IO.File]::WriteAllText($officialExe, 'the official claude.exe')
  $officialHash = Get-Sha $officialExe
  # Set in this process, not through -Env, so what is checked afterwards is
  # what the installer itself left behind.
  $env:CALICO_BIN_LINK = 'C:\should\not\reach\the\updater.exe'
  $env:CALICO_STATE_DIR = 'C:\nope'
  $env:CALICO_VERSIONS_DIR = 'C:\nope2'
  $rc = Invoke-Installer
  Same 'fresh install exits 0' 0 $rc
  $freshOut = $Out
  $uris = @($global:T.Requests | ForEach-Object { $_.Uri })
  Same 'the first request resolves main through the API' 'https://api.github.com/repos/Nanako0129/calico-claude/commits/main' $uris[0]
  Same 'the API request asks for the bare SHA' 'application/vnd.github.sha' $global:T.Requests[0].Accept
  Same 'exactly one API request' 1 (Get-ApiCount)
  Same 'the other request is update.ps1 at the SHA' "https://raw.githubusercontent.com/Nanako0129/calico-claude/$FakeSha/examples/local-auto-update/update.ps1" $uris[1]
  Same 'no request other than those two' 2 $uris.Count
  Same 'source-commit records the SHA' $FakeSha (Read-Text (Join-Path $State 'source-commit')).Trim()
  Same 'config names the repo' 'repo=Nanako0129/calico-claude' (Read-Text (Join-Path $State 'config')).Trim()
  Check 'the fetched updater is installed' (Test-SameFile $FakeUpdater (Join-Path $State 'update.ps1'))
  Same 'the updater ran once, with -Mode force, the repo, and no path overrides' 'force|repo=Nanako0129/calico-claude|link=unset|state=unset|versions=unset' (Read-Text $UpdaterLog).Trim()
  Same 'the path overrides are restored afterwards' 'C:\should\not\reach\the\updater.exe|C:\nope|C:\nope2|' "$env:CALICO_BIN_LINK|$env:CALICO_STATE_DIR|$env:CALICO_VERSIONS_DIR|$env:CALICO_REPO"
  Has "the updater's output is relayed" 'fake updater ran'
  Has 'the exact uninstall command is printed' "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nanako0129/calico-claude/$FakeSha/install-patched-claude.ps1))) -Uninstall"
  Has 'the footprint lists the hook command' $HookCmd
  Has 'the footprint lists the source commit' "source-commit  ($FakeSha)"
  Has 'the footprint lists the task' "Task Scheduler $TestTaskPath$TestTaskName"
  Has 'the footprint names the installed release' 'Release: v9.9.9-win32-x64'
  Same 'the official claude.exe is untouched' $officialHash (Get-Sha $officialExe)

  Same 'missing settings.json: one Calico hook, the exact command' "1|$HookCmd" (Get-CalicoHooks $SettingsPath)
  Same 'missing settings.json: contract-equal to {}' 'equal' (Compare-Contract $missing $SettingsPath)
  Check 'missing settings.json: no backup of nothing' (-not (Test-Path -LiteralPath "$SettingsPath.calico-bak"))
  $expectedEntry = '{"type":"command","command":"' + $HookCmd.Replace('"', '\"') + '","timeout":10,"async":true}'
  $firstBytes = [IO.File]::ReadAllBytes($SettingsPath)
  Check 'settings.json has no BOM' ($firstBytes[0] -eq 0x7B)
  Same 'the whole file, byte for byte' ("{`n  `"hooks`": {`n    `"SessionStart`": [`n      {`n        `"hooks`": [`n          {`n            `"type`": `"command`",`n            `"command`": `"" + $HookCmd.Replace('"', '\"') + "`",`n            `"timeout`": 10,`n            `"async`": true`n          }`n        ]`n      }`n    ]`n  }`n}`n") (Read-Text $SettingsPath)

  # The task, as registered.
  $task = Get-TestTask
  Check 'task: registered under the test folder with the SID name' ($null -ne $task)
  if ($task) {
    $a = @($task.Actions)[0]
    # Through conhost --headless where Windows has it (build 17763 and later),
    # so the hourly run opens no window; the plain action below that.
    $taskPs = '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode unattended-run' -f (Join-Path $State 'update.ps1')
    if ([Environment]::OSVersion.Version.Build -ge 17763) {
      Same 'task: runs conhost by its %SystemRoot% path' '%SystemRoot%\System32\conhost.exe' $a.Execute
      Same 'task: conhost --headless runs Windows PowerShell with update.ps1 -Mode unattended-run' ("--headless `"$taskPs`" $taskArgs") $a.Arguments
      Check 'task: no console-window note on this build' (-not $Out.Contains('shows a console window'))
    } else {
      Same 'task: runs Windows PowerShell by its %SystemRoot% path' $taskPs $a.Execute
      Same 'task: runs update.ps1 -Mode unattended-run' $taskArgs $a.Arguments
      Has 'task: says the task shows a window on this build' 'shows a console window'
    }
    Same 'task: one action' 1 @($task.Actions).Count
    Same 'task: as the current user' $env:USERNAME ($task.Principal.UserId -replace '^.*\\', '')
    Same 'task: Interactive logon, no stored password' 'Interactive' "$($task.Principal.LogonType)"
    Same 'task: limited token' 'Limited' "$($task.Principal.RunLevel)"
    $tr = @($task.Triggers)
    Same 'task: one trigger' 1 $tr.Count
    Same 'task: repeats hourly' 'PT1H' $tr[0].Repetition.Interval
    Same 'task: repeats indefinitely' '' "$($tr[0].Repetition.Duration)"
    $start = [DateTime]::Parse($tr[0].StartBoundary)
    Check 'task: first run about an hour out' ($start -gt (Get-Date).AddMinutes(50) -and $start -lt (Get-Date).AddMinutes(61)) "$($tr[0].StartBoundary)"
    Check 'task: starts on battery' (-not $task.Settings.DisallowStartIfOnBatteries -and -not $task.Settings.StopIfGoingOnBatteries)
    Same 'task: time limit one hour' 'PT1H' $task.Settings.ExecutionTimeLimit
  }

  # --- 3. an immediate second install ---------------------------------------------
  $firstSettings = [IO.File]::ReadAllBytes($SettingsPath)
  $rc = Invoke-Installer
  Same 'second install exits 0' 0 $rc
  Check 'second install: settings.json byte-identical' ([Convert]::ToBase64String($firstSettings) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($SettingsPath)))
  Check 'second install: no backup written' (-not (Test-Path -LiteralPath "$SettingsPath.calico-bak"))
  Same 'second install: still one Calico hook' "1|$HookCmd" (Get-CalicoHooks $SettingsPath)
  Same 'second install: one task in the folder' $TestTaskName ((Get-TestTaskNames) -join ',')

  # The same through `irm | iex`, which evaluates the text in the caller's scope:
  # nothing may leak into it, and a success must not end the caller.
  Reset-Case 'iex'
  function Invoke-ViaIex {
    $ErrorActionPreference = 'Continue'
    Invoke-Expression $InstallerText *> $null
    $r = $global:LASTEXITCODE
    return @($r, $ErrorActionPreference, [bool](Get-Command Update-Settings -ErrorAction SilentlyContinue))
  }
  $r = Invoke-ViaIex
  Same 'iex: installs, exit 0' 0 $r[0]
  Same "iex: the caller's ErrorActionPreference is unchanged" 'Continue' $r[1]
  Same "iex: no function leaks into the caller" 'False' $r[2]
  Same 'iex: the hook is wired' "1|$HookCmd" (Get-CalicoHooks $SettingsPath)

  # --- 4. settings merge fixtures -----------------------------------------------------
  function Test-MergeCase {
    param([string]$Fixture, [string]$Label)
    Reset-Case $Label
    Copy-Item -LiteralPath $Fixture -Destination $SettingsPath
    $rc = Invoke-Installer
    Same "${Label}: install exits 0" 0 $rc
    Same "${Label}: exactly one Calico hook" "1|$HookCmd" (Get-CalicoHooks $SettingsPath)
    Same "${Label}: contract-equal to the input" 'equal' (Compare-Contract $Fixture $SettingsPath)
    Check "${Label}: backup holds the input" (Test-SameFile $Fixture "$SettingsPath.calico-bak")
    Check "${Label}: backup is readable by the current user only" (Test-OwnerOnlyAcl "$SettingsPath.calico-bak")
    Same "${Label}: no temp file left" 0 (Get-TempLeftovers)
  }
  Test-MergeCase (Join-Path $Fx 'empty.json') 'empty file'
  Test-MergeCase (Join-Path $Fx 'no-hooks.json') 'no hooks key'
  Same 'no hooks key: hooks appended after the existing keys' 'model permissions env hooks' ((Read-Text $SettingsPath | ConvertFrom-Json).PSObject.Properties.Name -join ' ')
  Test-MergeCase (Join-Path $Fx 'unrelated.json') 'unrelated hooks, nesting, non-ASCII'
  $groups = (Read-Text $SettingsPath | ConvertFrom-Json).hooks.SessionStart
  Same 'unrelated: ours is appended after the existing groups' "$kido|C:/bin/other-hook.exe|$HookCmd" ((@($groups) | ForEach-Object { $_.hooks[0].command }) -join '|')
  $installed = Read-Text $SettingsPath
  Check 'non-ASCII is written as UTF-8, not escaped' ($installed.Contains("`"zeta`": `"$nonAscii`""))
  Check 'a date-looking string stays the same string' ($installed.Contains('"stamp": "2026-09-24T10:00:00Z"') -and $installed.Contains('"day": "2026-09-24"'))
  Check 'numbers keep their source text' ($installed.Contains("1.0,`n    1e5,`n    -0,`n    0.1,`n    12345678901234567890`n"))
  Check 'numeric-looking keys stay keys, in order' ($installed.Contains("`"1`": `"one`",`n  `"0`": `"zero`""))
  $installedCopy = Join-Path $Sandbox 'unrelated-installed.json'
  Copy-Item -LiteralPath $SettingsPath -Destination $installedCopy
  Test-MergeCase (Join-Path $Fx 'stale.json') 'stale Calico entries'
  $groups = (Read-Text $SettingsPath | ConvertFrom-Json).hooks.SessionStart
  Same 'stale: the first stale entry is replaced in place, the second removed' "startup:echo before,$HookCmd,echo after|-:echo unrelated" ((@($groups) | ForEach-Object { $m = if ($_.matcher) { $_.matcher } else { '-' }; "${m}:" + ((@($_.hooks) | ForEach-Object { $_.command }) -join ',') }) -join '|')

  # The contract must be able to turn this suite red: the installed output with
  # one unrelated string changed is not equal to the input.
  Write-Fixture (Join-Path $Sandbox 'tampered.json') ((Read-Text $installedCopy).Replace($kido, "$kido!"))
  Same 'contract flags an installed file whose unrelated hook changed' 'unequal' (Compare-Contract (Join-Path $Fx 'unrelated.json') (Join-Path $Sandbox 'tampered.json'))

  # A UTF-8 BOM is read, and written back without one.
  Reset-Case 'BOM input'
  [IO.File]::WriteAllBytes($SettingsPath, [byte[]]([byte[]](0xEF, 0xBB, 0xBF) + $Utf8.GetBytes('{"theme": "dark"}' + "`n")))
  Copy-Item -LiteralPath $SettingsPath -Destination (Join-Path $Sandbox 'bom.json')
  $rc = Invoke-Installer
  Same 'BOM input: install exits 0' 0 $rc
  Same 'BOM input: output has no BOM' 123 ([IO.File]::ReadAllBytes($SettingsPath)[0])
  Same 'BOM input: contract-equal' 'equal' (Compare-Contract (Join-Path $Sandbox 'bom.json') $SettingsPath)
  Check 'BOM input: the backup keeps the BOM' (Test-SameFile (Join-Path $Sandbox 'bom.json') "$SettingsPath.calico-bak")

  # What ConvertFrom-Json cannot carry, byte for byte: an empty key, keys that
  # differ only in case, keys named like dictionary members, a string 5.1 would
  # turn into a DateTime, escapes, a non-BMP character, number spellings.
  Reset-Case 'exotic values'
  Write-Fixture $SettingsPath ('{"": "empty key", "a": 1, "A": 2, "d": "\/Date(1234567890000)\/", "Count": {"Keys": [], "Values": {}},' +
    ' "esc": "\u0001\t\"\\' + (U 0x2028) + '<>&''", "sur": "\ud83d\ude00", "n": [1.0, 1E+2, -0.0e-0, 12345678901234567890]}')
  Copy-Item -LiteralPath $SettingsPath -Destination (Join-Path $Sandbox 'exotic.json')
  $rc = Invoke-Installer
  Same 'exotic: install exits 0' 0 $rc
  $escHook = $HookCmd.Replace('"', '\"')
  $body = "  `"`": `"empty key`",`n  `"a`": 1,`n  `"A`": 2,`n  `"d`": `"/Date(1234567890000)/`",`n  `"Count`": {`n    `"Keys`": [],`n    `"Values`": {}`n  },`n" +
    "  `"esc`": `"\u0001\t\`"\\" + (U 0x2028) + "<>&'`",`n  `"sur`": `"" + (U 0x1F600) + "`",`n  `"n`": [`n    1.0,`n    1E+2,`n    -0.0e-0,`n    12345678901234567890`n  ]"
  $hooksBlock = ",`n  `"hooks`": {`n    `"SessionStart`": [`n      {`n        `"hooks`": [`n          {`n            `"type`": `"command`",`n            `"command`": `"$escHook`",`n            `"timeout`": 10,`n            `"async`": true`n          }`n        ]`n      }`n    ]`n  }"
  Same 'exotic: written exactly' ("{`n$body$hooksBlock`n}`n") (Read-Text $SettingsPath)
  $exoticInstalled = [IO.File]::ReadAllBytes($SettingsPath)
  $rc = Invoke-Installer
  Check 'exotic: a re-run is byte-identical' ($rc -eq 0 -and [Convert]::ToBase64String($exoticInstalled) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($SettingsPath)))
  $rc = Invoke-Installer -Uninstall
  Same 'exotic: uninstall exits 0' 0 $rc
  Same 'exotic: uninstall leaves exactly the input, pretty-printed' ("{`n$body`n}`n") (Read-Text $SettingsPath)

  # Nesting: 100 levels round-trip; 101 is refused rather than truncated.
  foreach ($depth in 100, 101) {
    Reset-Case "nesting $depth"
    $text = '{"x": ' + ('[' * ($depth - 1)) + '7' + (']' * ($depth - 1)) + '}'
    Write-Fixture $SettingsPath $text
    $rc = Invoke-Installer
    if ($depth -eq 100) {
      Same 'nesting 100: install exits 0' 0 $rc
      Check 'nesting 100: the nested value survives intact' ((Read-Text $SettingsPath).Replace(' ', '').Replace("`n", '').Contains('"x":' + ('[' * 99) + '7' + (']' * 99) + ',"hooks"'))
    } else {
      Same 'nesting 101: refused' 1 $rc
      Same 'nesting 101: bytes unchanged' $text (Read-Text $SettingsPath)
      Has 'nesting 101: says why' 'nesting deeper than 100 levels'
    }
  }

  # A symlinked settings.json: the target is updated, the link stays a link.
  # Creating a symlink needs admin rights or Developer Mode, and this suite runs
  # without admin rights, so -SymlinkHome can supply one made beforehand:
  #   <dir>\.claude\settings.json -> ..\dotfiles\settings.json  (relative)
  Reset-Case 'symlink'
  $linkHome = $H
  $made = $false
  if ($SymlinkHome) { $linkHome = $SymlinkHome; $made = $true }
  else {
    New-Item -ItemType Directory -Force -Path (Join-Path $H 'dotfiles') | Out-Null
    # mklink keeps a relative target as written; 5.1's New-Item resolves it.
    # Its refusal goes to stderr, which 5.1 under 'Stop' turns into a
    # terminating error, so it runs under 'Continue' and the exit code decides.
    $made = & {
      $ErrorActionPreference = 'Continue'
      & cmd.exe /c mklink $SettingsPath '..\dotfiles\settings.json' *> $null
      $LASTEXITCODE -eq 0
    }
  }
  if (-not $made) {
    $script:Skip++
    Write-Host 'SKIP symlink: cannot create a symlink here (needs admin or Developer Mode); pass -SymlinkHome'
  } else {
    $linkSettings = Join-Path $linkHome '.claude\settings.json'
    $target = Join-Path $linkHome 'dotfiles\settings.json'
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item -LiteralPath (Join-Path $Fx 'unrelated.json') -Destination $target
    foreach ($f in @("$target.calico-bak", (Join-Path $linkHome '.claude\calico'), (Join-Path $linkHome '.local'))) { Remove-Item -LiteralPath $f -Recurse -Force -ErrorAction SilentlyContinue }
    $linkHook = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}/.claude/calico/update.ps1" -Mode hook' -f ($linkHome -replace '\\', '/')
    $rc = Invoke-Installer -Env @{ USERPROFILE = $linkHome; HOME = $linkHome }
    Same 'symlink: install exits 0' 0 $rc
    $li = Get-Item -LiteralPath $linkSettings -Force
    Check 'symlink: settings.json is still the same link' (($li.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (@($li.Target)[0] -eq '..\dotfiles\settings.json')) "$(@($li.Target)[0])"
    Same 'symlink: the target carries the hook' "1|$linkHook" (Get-CalicoHooks $target)
    Same 'symlink: the target is contract-equal to the input' 'equal' (Compare-Contract (Join-Path $Fx 'unrelated.json') $target)
    Check 'symlink: the backup sits beside the target' (Test-SameFile (Join-Path $Fx 'unrelated.json') "$target.calico-bak")
    $rc = Invoke-Installer -Uninstall -Env @{ USERPROFILE = $linkHome; HOME = $linkHome }
    Same 'symlink: uninstall exits 0' 0 $rc
    Check 'symlink: still a link after uninstall' ([bool]((Get-Item -LiteralPath $linkSettings -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))
    Same 'symlink: uninstall restores the input' 'equal' (Compare-Contract (Join-Path $Fx 'unrelated.json') $target)
  }

  # Refusals: the file is left byte-for-byte, and nothing after the merge runs.
  function Test-RefuseCase {
    param([string]$Label, [byte[]]$Bytes, [string]$Message = '')
    Reset-Case $Label
    [IO.File]::WriteAllBytes($SettingsPath, $Bytes)
    $rc = Invoke-Installer
    Same "${Label}: install fails" 1 $rc
    Check "${Label}: bytes unchanged" ([Convert]::ToBase64String($Bytes) -ceq [Convert]::ToBase64String([IO.File]::ReadAllBytes($SettingsPath)))
    Check "${Label}: no backup written" (-not (Test-Path -LiteralPath "$SettingsPath.calico-bak"))
    Same "${Label}: no temp file left" 0 (Get-TempLeftovers)
    Check "${Label}: the task is not registered" ($null -eq (Get-TestTask))
    Has "${Label}: the uninstall command is printed for what was already installed" ') -Uninstall'
    Has "${Label}: says how to add the hook by hand" 'To wire it by hand'
    if ($Message) { Has "${Label}: says why" $Message }
  }
  function B { param([string]$Text) , $Utf8.GetBytes($Text) }
  Test-RefuseCase 'invalid JSON' (B '{"hooks": {"SessionStart": [}') 'cannot parse'
  Test-RefuseCase 'duplicate key' (B '{"theme": "dark", "theme": "light"}') "duplicate key 'theme'"
  Test-RefuseCase 'NaN' (B '{"x": NaN}') "unexpected character 'N'"
  Test-RefuseCase 'trailing comma' (B '{"x": 1,}') 'expected a string key'
  Test-RefuseCase 'comment' (B "{`"x`": 1 // note`n}") "expected ',' or '}'"
  Test-RefuseCase 'single quotes' (B "{'x': 1}") 'expected a string key'
  Test-RefuseCase 'leading zero' (B '{"x": 01}') "expected ',' or '}'"
  Test-RefuseCase 'trailing text' (B '{"x": 1} {}') 'unexpected text after the JSON value'
  Test-RefuseCase 'top-level array' (B '[1, 2]') 'does not hold a JSON object'
  Test-RefuseCase 'hooks is not an object' (B '{"hooks": []}') '"hooks" is not an object'
  Test-RefuseCase 'SessionStart is not an array' (B '{"hooks": {"SessionStart": {}}}') '"hooks.SessionStart" is not an array'
  Test-RefuseCase 'invalid UTF-8' ([byte[]](0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D)) 'is not valid UTF-8'
  Test-RefuseCase 'UTF-16 file' ([byte[]](0xFF, 0xFE) + [Text.Encoding]::Unicode.GetBytes('{}')) 'is not valid UTF-8'
  Test-RefuseCase 'control character in a string' (B "{`"x`": `"a`tb`"}") 'control character in a string'
  Test-RefuseCase 'invalid escape' (B '{"x": "\q"}') 'invalid escape'
  Test-RefuseCase 'lone surrogate escape' (B '{"x": "\ud800"}') 'cannot be written back'

  # Another writer changes the file between the read and the rename. The
  # installer sets the backup's ACL in between; the shadow below appends to
  # settings.json first, as another writer would.
  Reset-Case 'concurrent change'
  Copy-Item -LiteralPath (Join-Path $Fx 'unrelated.json') -Destination $SettingsPath
  function Invoke-WithConcurrentWriter {
    function Set-Acl {
      param([string]$LiteralPath, $AclObject)
      [IO.File]::AppendAllText($SettingsPath, ' ')
      Microsoft.PowerShell.Security\Set-Acl -LiteralPath $LiteralPath -AclObject $AclObject
    }
    Invoke-Installer
  }
  $rc = Invoke-WithConcurrentWriter
  Same 'concurrent change: install fails' 1 $rc
  Has 'concurrent change: says so' 'changed while it was being updated'
  Same "concurrent change: the other writer's bytes survive" ((Read-Text (Join-Path $Fx 'unrelated.json')) + ' ') (Read-Text $SettingsPath)
  Same 'concurrent change: no temp file left' 0 (Get-TempLeftovers)
  Check 'concurrent change: no backup written' (-not (Test-Path -LiteralPath "$SettingsPath.calico-bak"))

  # Backup: replaced each run, owner-only even when the old one was not.
  Reset-Case 'backup'
  Copy-Item -LiteralPath (Join-Path $Fx 'no-hooks.json') -Destination $SettingsPath
  $bak = "$SettingsPath.calico-bak"
  [IO.File]::WriteAllText($bak, 'OLD BACKUP')
  $open = Get-Acl -LiteralPath $bak
  $open.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('Everyone', 'Read', 'Allow')))
  Set-Acl -LiteralPath $bak -AclObject $open
  $rc = Invoke-Installer
  Same 'backup: install exits 0' 0 $rc
  Check "backup: the old backup is replaced by this run's input" (Test-SameFile (Join-Path $Fx 'no-hooks.json') $bak)
  Check "backup: owner-only regardless of the old file's ACL" (Test-OwnerOnlyAcl $bak)
  Same 'backup: exactly one backup file' 1 @(Get-ChildItem -LiteralPath (Join-Path $H '.claude') -Force | Where-Object { $_.Name -like '*calico-bak*' }).Count
  $rc = Invoke-Installer
  Check 'backup: a no-op re-run keeps the pre-install backup' (Test-SameFile (Join-Path $Fx 'no-hooks.json') $bak)

  # --- 5. the updater or the task fails -----------------------------------------------
  Reset-Case 'updater fails'
  Copy-Item -LiteralPath (Join-Path $Fx 'no-hooks.json') -Destination $SettingsPath
  $rc = Invoke-Installer -Env @{ FAKE_UPDATER_RC = '3' }
  Same 'updater failure fails the install' 1 $rc
  Has 'updater failure: names the exit code' 'exit 3'
  Check 'updater failure: settings.json untouched' (Test-SameFile (Join-Path $Fx 'no-hooks.json') $SettingsPath)
  Check 'updater failure: no task' ($null -eq (Get-TestTask))
  Has 'updater failure: the uninstall command is printed' ') -Uninstall'

  # A re-run whose updater fails while the launcher from the earlier install is
  # still there: the failure must still stop it.
  Reset-Case 'updater fails with a launcher present'
  $rc = Invoke-Installer
  Copy-Item -LiteralPath (Join-Path $Fx 'no-hooks.json') -Destination $SettingsPath -Force
  Remove-TestTask
  $rc = Invoke-Installer -Env @{ FAKE_UPDATER_RC = '3' }
  Same 'updater failure with an existing launcher fails the install' 1 $rc
  Has 'updater failure with an existing launcher: says so' 'The updater could not install calico-claude'
  Check 'updater failure with an existing launcher: settings.json untouched' (Test-SameFile (Join-Path $Fx 'no-hooks.json') $SettingsPath)
  Check 'updater failure with an existing launcher: no task' ($null -eq (Get-TestTask))

  Reset-Case 'no launcher after the updater'
  $rc = Invoke-Installer -Env @{ FAKE_UPDATER_NOLINK = '1' }
  Same 'no launcher after the updater fails the install' 1 $rc
  Has 'no launcher: says so' 'calico-claude.exe is missing'
  Check 'no launcher: settings.json not written' (-not (Test-Path -LiteralPath $SettingsPath))

  Reset-Case 'task registration fails'
  Copy-Item -LiteralPath (Join-Path $Fx 'no-hooks.json') -Destination $SettingsPath
  function Invoke-WithFailingRegister {
    function Register-ScheduledTask { throw 'Access is denied (injected)' }
    Invoke-Installer
  }
  $rc = Invoke-WithFailingRegister
  Same 'task registration failure fails the install' 1 $rc
  Has 'task registration failure: says so' 'Could not register the scheduled task'
  Has 'task registration failure: the uninstall command is printed' ') -Uninstall'

  # --- 6. repo selection and credentials ------------------------------------------------
  Reset-Case 'CALICO_REPO'
  $rc = Invoke-Installer -Env @{ CALICO_REPO = 'fork-owner/calico-fork' }
  Same 'CALICO_REPO: install exits 0' 0 $rc
  Same 'CALICO_REPO: config' 'repo=fork-owner/calico-fork' (Read-Text (Join-Path $State 'config')).Trim()
  Same 'CALICO_REPO: every request goes to the fork' 2 @($global:T.Requests | Where-Object { $_.Uri.Contains('/fork-owner/calico-fork/') }).Count
  Same 'CALICO_REPO: the updater installs from the fork' 'force|repo=fork-owner/calico-fork|link=unset|state=unset|versions=unset' (Read-Text $UpdaterLog).Trim()
  Has 'CALICO_REPO: the uninstall command points at the fork' "https://raw.githubusercontent.com/fork-owner/calico-fork/$FakeSha/install-patched-claude.ps1"

  Reset-Case 'PATCH_CLAUDE_REPO'
  $rc = Invoke-Installer -Env @{ CALICO_REPO = 'loses/this'; PATCH_CLAUDE_REPO = 'wins/this' }
  Same 'PATCH_CLAUDE_REPO wins over CALICO_REPO' 'repo=wins/this' (Read-Text (Join-Path $State 'config')).Trim()

  Reset-Case 'CALICO_SOURCE_REF'
  $rc = Invoke-Installer -Env @{ CALICO_SOURCE_REF = 'some-branch' }
  Same 'CALICO_SOURCE_REF is resolved, and the file still comes by SHA' "https://api.github.com/repos/Nanako0129/calico-claude/commits/some-branch|1" ("$($global:T.Requests[0].Uri)|" + @($global:T.Requests | Where-Object { $_.Uri.Contains("/$FakeSha/") }).Count)

  foreach ($answer in 'main', ($FakeSha.ToUpperInvariant()), ($FakeSha + '0')) {
    Reset-Case "API answer '$answer'"
    $global:T.ShaAnswer = $answer
    $rc = Invoke-Installer
    Same "API answer '$answer': refused" 1 $rc
    Check "API answer '$answer': nothing written, nothing else fetched" (-not (Test-Path -LiteralPath $State) -and $global:T.Requests.Count -eq 1)
  }

  Reset-Case 'token order'
  $null = Invoke-Installer -Env @{ GITHUB_TOKEN = 't-github'; GH_TOKEN = 't-gh'; CALICO_TEST_GH_RC = '0'; CALICO_TEST_GH_OUT = 't-cli' }
  $a1 = $global:T.Requests[0].Auth; $raw1 = $global:T.Requests[1].Auth; $global:T.Requests.Clear()
  $null = Invoke-Installer -Env @{ GH_TOKEN = 't-gh'; CALICO_TEST_GH_RC = '0'; CALICO_TEST_GH_OUT = 't-cli' }
  $a2 = $global:T.Requests[0].Auth; $global:T.Requests.Clear()
  $null = Invoke-Installer -Env @{ CALICO_TEST_GH_RC = '0'; CALICO_TEST_GH_OUT = 't-cli' }
  $a3 = $global:T.Requests[0].Auth; $global:T.Requests.Clear()
  $null = Invoke-Installer -Env @{ CALICO_TEST_GH_RC = '1'; CALICO_TEST_GH_OUT = 't-unauthenticated' }
  $a4 = $global:T.Requests[0].Auth; $global:T.Requests.Clear()
  $null = Invoke-Installer
  $a5 = $global:T.Requests[0].Auth
  Same 'GITHUB_TOKEN first' 'Bearer t-github' $a1
  Same 'the raw download carries no token' '' "$raw1"
  Same 'then GH_TOKEN' 'Bearer t-gh' $a2
  Same 'then gh auth token' 'Bearer t-cli' $a3
  Same 'gh output with a non-zero exit is not a token' '' "$a4"
  Same 'no credential: no header' '' "$a5"
  Check 'no token in the output' (-not $Out.Contains('t-cli') -and -not $Out.Contains('t-github'))

  # --- 7. the official claude ------------------------------------------------------------
  [IO.File]::WriteAllText((Join-Path $ClaudeBin 'claude.cmd'), "@echo 2.1.281 (Claude Code) (patched)`r`n")
  $claudeHash = Get-Sha (Join-Path $ClaudeBin 'claude.cmd')
  Reset-Case 'patched official claude'
  $env:PATH = "$ClaudeBin;$env:PATH"
  $rc = Invoke-Installer
  Same 'patched official claude: install exits 0' 0 $rc
  Has 'patched official claude: says how to restore' 'irm https://claude.ai/install.ps1 | iex'
  Same 'patched official claude: left byte-for-byte' $claudeHash (Get-Sha (Join-Path $ClaudeBin 'claude.cmd'))
  $rc = Invoke-Installer -Uninstall
  Has 'patched official claude: uninstall says it too' 'irm https://claude.ai/install.ps1 | iex'
  [IO.File]::WriteAllText((Join-Path $ClaudeBin 'claude.cmd'), "@echo 2.1.281 (Claude Code)`r`n")
  Reset-Case 'official claude'
  $env:PATH = "$ClaudeBin;$env:PATH"
  $rc = Invoke-Installer
  Check 'official claude: no restore notice' ($rc -eq 0 -and -not $Out.Contains('claude.ai/install.ps1'))

  # --- 8. uninstall ----------------------------------------------------------------------
  function Test-UninstallCase {
    param([string]$Fixture, [string]$Label)
    Reset-Case $Label
    if (Test-Path -LiteralPath $Fixture) { Copy-Item -LiteralPath $Fixture -Destination $SettingsPath }
    # Neighbours that are not Calico's, the official claude.exe among them.
    $neighbours = @('.local\bin\claude.exe', '.local\bin\other.exe', '.local\share\claude\versions\2.1.281', '.local\share\other\f', '.claude\projects\f')
    foreach ($n in $neighbours) { $p = Join-Path $H $n; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null; [IO.File]::WriteAllText($p, "keep $n") }
    $rc = Invoke-Installer
    Same "${Label}: install exits 0" 0 $rc
    $aside = Join-Path $H '.local\bin\calico-claude.exe.calico-old.1790000000000'
    [IO.File]::WriteAllText($aside, 'an old launcher')
    $rc = Invoke-Installer -Uninstall
    Same "${Label}: uninstall exits 0" 0 $rc
    Same "${Label}: contract-equal to the pre-install input" 'equal' (Compare-Contract $Fixture $SettingsPath)
    $left = @(@($LauncherPath, $aside, (Join-Path $H '.local\share\calico-claude'), $State) | Where-Object { Test-Path -LiteralPath $_ })
    Check "${Label}: launcher, asides, builds and state removed" ($left.Count -eq 0) ($left -join ', ')
    $lost = @($neighbours | Where-Object { (Read-Text (Join-Path $H $_)) -ne "keep $_" })
    Check "${Label}: unrelated files kept, the official claude.exe among them" ($lost.Count -eq 0) ($lost -join ', ')
    Check "${Label}: the task is gone" ($null -eq (Get-TestTask))
    Check "${Label}: the task folder is gone" (-not (Test-TaskFolder))
    $rc = Invoke-Installer -Uninstall
    Same "${Label}: a second uninstall exits 0" 0 $rc
  }
  Test-UninstallCase $missing 'uninstall (no settings.json before)'
  Same 'uninstall (no settings.json before): what remains is {}' '{}' ((Read-Text $SettingsPath) -replace '\s', '')
  Test-UninstallCase (Join-Path $Fx 'empty.json') 'uninstall (empty settings.json)'
  Test-UninstallCase (Join-Path $Fx 'no-hooks.json') 'uninstall (no hooks)'
  Same 'uninstall (no hooks): the hooks key it added is gone' 'model permissions env' ((Read-Text $SettingsPath | ConvertFrom-Json).PSObject.Properties.Name -join ' ')
  Test-UninstallCase (Join-Path $Fx 'unrelated.json') 'uninstall (unrelated hooks)'
  Test-UninstallCase (Join-Path $Fx 'stale.json') 'uninstall (stale entries)'
  Same 'uninstall (stale entries): no Calico hook remains' '0|' (Get-CalicoHooks $SettingsPath)

  # A launcher that does not match the updater's record was not installed by it.
  Reset-Case 'uninstall: foreign launcher'
  $rc = Invoke-Installer
  [IO.File]::WriteAllText($LauncherPath, 'MINE')
  $rc = Invoke-Installer -Uninstall
  Same 'uninstall: a launcher not matching the record is kept' 'MINE' (Read-Text $LauncherPath)
  Has 'uninstall: says why it kept it' 'it is not the build the updater recorded installing'

  # A launcher still running cannot be deleted: the state that proves it is
  # ours is kept, so the uninstall can be run again.
  Reset-Case 'uninstall: launcher in use'
  $rc = Invoke-Installer
  $held = [IO.File]::Open($LauncherPath, 'Open', 'Read', 'Read')
  try { $rc = Invoke-Installer -Uninstall } finally { $held.Dispose() }
  Same 'uninstall: a launcher in use fails the uninstall' 1 $rc
  Has 'uninstall: says to close sessions and run it again' 'run the uninstall command again'
  Check 'uninstall: the record is kept for the next attempt' (Test-Path -LiteralPath (Join-Path $State 'installed-tag'))
  $rc = Invoke-Installer -Uninstall
  Check 'uninstall: the second attempt finishes' ($rc -eq 0 -and -not (Test-Path -LiteralPath $LauncherPath) -and -not (Test-Path -LiteralPath $State))

  # Another task in the same folder: ours goes, the folder and the other stay.
  Reset-Case 'uninstall: task folder shared'
  $rc = Invoke-Installer
  Register-ScheduledTask -TaskPath $TestTaskPath -TaskName 'neighbour' -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0') -Principal (New-ScheduledTaskPrincipal -UserId $Me.Name -LogonType Interactive -RunLevel Limited) | Out-Null
  $rc = Invoke-Installer -Uninstall
  Same 'uninstall: shared folder: exits 0' 0 $rc
  Check 'uninstall: shared folder: ours is gone' ($null -eq (Get-TestTask))
  Check 'uninstall: shared folder: the other task stays' (Test-TaskExists 'neighbour')

  # A scheduler error other than "not found" fails the uninstall instead of
  # passing for "already gone", and leaves the rest for a retry. The shadow
  # hands the installer a Schedule.Service whose DeleteTask throws, and passes
  # every other New-Object through.
  Reset-Case 'uninstall: scheduler error'
  $rc = Invoke-Installer
  function Invoke-WithBrokenScheduler {
    function New-Object {
      param([string]$TypeName, [object[]]$ArgumentList, [string]$ComObject)
      if ($ComObject -eq 'Schedule.Service') {
        $folder = [pscustomobject]@{}
        $folder | Add-Member -MemberType ScriptMethod -Name DeleteTask -Value { throw [UnauthorizedAccessException]::new('Access is denied (injected)') }
        $service = [pscustomobject]@{ Folder = $folder }
        $service | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
        $service | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { $this.Folder }
        return $service
      }
      if ($PSBoundParameters.ContainsKey('ArgumentList')) { return Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList }
      return Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName
    }
    Invoke-Installer -Uninstall
  }
  $rc = Invoke-WithBrokenScheduler
  Same 'uninstall: a scheduler error fails the uninstall' 1 $rc
  Has 'uninstall: the scheduler error is shown' 'Access is denied (injected)'
  Check 'uninstall: a scheduler error leaves the task, launcher and state for a retry' ((Test-TaskExists) -and (Test-Path -LiteralPath $LauncherPath) -and (Test-Path -LiteralPath (Join-Path $State 'installed-tag')))

  # settings.json that does not parse: uninstall refuses before removing anything.
  Reset-Case 'uninstall: unparsable settings.json'
  $rc = Invoke-Installer
  [IO.File]::WriteAllText($SettingsPath, '{broken')
  $rc = Invoke-Installer -Uninstall
  Same 'uninstall with unparsable settings.json fails' 1 $rc
  Check 'uninstall with unparsable settings.json removes nothing' ((Test-Path -LiteralPath $LauncherPath) -and (Test-Path -LiteralPath (Join-Path $State 'update.ps1')) -and $null -ne (Get-TestTask))
  Same 'uninstall with unparsable settings.json leaves its bytes' '{broken' (Read-Text $SettingsPath)

  Reset-Case 'uninstall: clean profile'
  $rc = Invoke-Installer -Uninstall
  Same 'uninstall on a clean profile exits 0' 0 $rc
  Check 'uninstall on a clean profile creates no settings.json' (-not (Test-Path -LiteralPath $SettingsPath))

  # A valid file without our hook keeps its exact bytes.
  Reset-Case 'uninstall: no Calico hook'
  Copy-Item -LiteralPath (Join-Path $Fx 'reindented.json') -Destination $SettingsPath
  $rc = Invoke-Installer -Uninstall
  Check 'uninstall without a Calico hook leaves the file byte-for-byte' ($rc -eq 0 -and (Test-SameFile (Join-Path $Fx 'reindented.json') $SettingsPath))
} catch {
  $Fail++
  Write-Host ("FAIL suite crashed: {0} (0x{1:X8}): {2} at line {3}" -f $_.Exception.GetType().FullName, $_.Exception.HResult, $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber)
} finally {
  foreach ($n in $EnvNames) { [Environment]::SetEnvironmentVariable($n, $SavedEnv[$n]) }
  try {
    Remove-TestTask
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    try { $service.GetFolder('\').DeleteFolder($TestTaskPath.Trim('\'), 0) } catch { }
    if (Test-TaskFolder) { $Fail++; Write-Host "FAIL cleanup: task folder $TestTaskPath is still there" }
  } catch { $Fail++; Write-Host "FAIL cleanup: $($_.Exception.Message)" }
  Remove-Variable -Name T -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "passed $Pass failed $Fail skipped $Skip"
  if ($Fail -ne 0 -or $Pass -eq 0) { exit 1 }
  exit 0
}
