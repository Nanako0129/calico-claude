<#
Calico bootstrapper for Windows.

Installs Calico side by side as calico-claude.exe and keeps it current. The
official claude.exe is never written. What it does, in order:

  1. Refuses to run elevated (an administrator token), and off Windows.
  2. Resolves the source ref (main) to one commit SHA with a single API call,
     then fetches update.ps1 from raw.githubusercontent.com at that SHA, so the
     updater comes from one known commit even if main moves mid-run.
  3. Writes %USERPROFILE%\.claude\calico\config (repo=<owner>/<name>), the
     updater %USERPROFILE%\.claude\calico\update.ps1, and source-commit.
  4. Runs the updater with -Mode force, which installs
     %USERPROFILE%\.local\bin\calico-claude.exe.
  5. Adds a SessionStart hook to %USERPROFILE%\.claude\settings.json that runs
     the updater in -Mode hook (at most hourly, never blocking startup).
  6. Registers an hourly scheduled task, \calico\auto-update-<your SID>, that
     runs the updater in -Mode unattended-run as you, not elevated, with no
     stored password.
  7. Prints every item it created and the exact uninstall command.

Usage, from a normal (not "Run as administrator") PowerShell:
  irm https://raw.githubusercontent.com/Nanako0129/calico-claude/main/install-patched-claude.ps1 | iex
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nanako0129/calico-claude/main/install-patched-claude.ps1))) -Uninstall

Environment:
  PATCH_CLAUDE_REPO / CALICO_REPO  Release repo (default Nanako0129/calico-claude).
                                   Written to the config, which is where the hook
                                   and the task read it from.
  GITHUB_TOKEN / GH_TOKEN          Token for the one API call; otherwise an
                                   authenticated gh supplies one.
  CALICO_SOURCE_REF                TESTING ONLY: ref to install from (default main).
  CALICO_TEST_TASK_PATH            TESTING ONLY: task folder to use instead of
                                   \calico\, so a test never touches the real task.
  CALICO_TEST_ASSUME_ELEVATED      TESTING ONLY: 1 makes the elevation check refuse.
                                   It can add a refusal, never remove one.

This file stays pure ASCII: Windows PowerShell 5.1 reads a BOM-less script as
the ANSI code page.
#>
param([switch]$Uninstall)

# Everything runs in a child scope: `irm | iex` evaluates this text in the
# caller's own scope, and the preferences and functions below must not leak into
# the user's session. For the same reason a failure never calls `exit` unless
# this is running as a script file: in a scriptblock or under iex, `exit` would
# close the user's PowerShell window. It sets $LASTEXITCODE instead.
& {
  param([bool]$Uninstall, [bool]$AsFile)

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $Repo = if ($env:PATCH_CLAUDE_REPO) { $env:PATCH_CLAUDE_REPO } elseif ($env:CALICO_REPO) { $env:CALICO_REPO } else { 'Nanako0129/calico-claude' }
  $SourceRef = if ($env:CALICO_SOURCE_REF) { $env:CALICO_SOURCE_REF } else { 'main' }
  $TaskPath = if ($env:CALICO_TEST_TASK_PATH) { $env:CALICO_TEST_TASK_PATH } else { '\calico\' }
  $Marker = '.claude/calico/update.'
  $WinPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $TaskExe = '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'
  $Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
  $NumberPattern = [regex]'\G-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'
  $JsonMaxDepth = 100
  # Shared mutable state; functions read it from this scope.
  $S = @{ Hint = ''; Sha = ''; UninstallCmd = '' }

  function Say { param([string]$Text = '') Write-Host $Text }
  function Fail { param([string]$Message) throw $Message }

  # --- refusals -----------------------------------------------------------------

  # Everything this installs belongs to one user and runs as that user. From an
  # elevated prompt the files would be written with an administrator token, and
  # a task registered from there could be given one too. A filtered (UAC) token
  # carries Administrators as deny-only, so IsInRole is false for it; measured
  # on Windows 11: False from a standard session, True over OpenSSH (elevated).
  function Assert-NotElevated {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($env:CALICO_TEST_ASSUME_ELEVATED -eq '1' -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Fail 'Do not run this installer as administrator. Open a normal PowerShell window (not "Run as administrator") and run it there; it installs into your own profile and needs no elevated rights.'
    }
  }

  function Assert-Inputs {
    if ($Repo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\z') { Fail "Invalid repository '$Repo': expected <owner>/<name>." }
    if ($SourceRef -notmatch '^[A-Za-z0-9._/-]+\z') { Fail "Invalid CALICO_SOURCE_REF '$SourceRef'." }
    if ($TaskPath -notmatch '^\\[A-Za-z0-9._-]+\\\z') { Fail "Invalid task path '$TaskPath'." }
    # USERPROFILE is written into the hook command inside double quotes, and
    # Claude Code runs hook commands under Git Bash, where these characters
    # are still interpreted.
    if ("$env:USERPROFILE" -notmatch '^[A-Za-z]:\\') { Fail "USERPROFILE must be an absolute path (got '$env:USERPROFILE')." }
    if ($env:USERPROFILE.IndexOfAny([char[]]@('"', '$', '`', "`n", "`r")) -ge 0) {
      Fail "USERPROFILE contains a character that cannot be quoted safely in the hook command: $env:USERPROFILE"
    }
  }

  # --- strict JSON --------------------------------------------------------------
  # ConvertFrom-Json is not strict and differs by version (measured on 5.1.26100
  # and 7.6.6): both take a duplicate key silently (last wins); 5.1 accepts NaN,
  # single quotes, unquoted keys and leading zeros, and turns "\/Date(...)\/"
  # strings into DateTime; 7 accepts comments, trailing commas, single quotes
  # and NaN; both refuse an empty key and keys differing only in case; and
  # ConvertTo-Json -Depth 100 truncates deeper values with only a warning on 7.
  # So settings.json is read and written by this small parser instead. Objects
  # are OrderedDictionary with an ordinal (case-sensitive) comparer, arrays are
  # List[object], strings are kept exactly, and a number keeps its source text,
  # so nothing is re-typed or re-formatted on the way through.

  function New-JsonObject { return [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal) }
  function New-JsonNumber { param([string]$Text) return [pscustomobject]@{ PSTypeName = 'CalicoJsonNumber'; Text = $Text } }
  function Test-JsonNumber { param($Value) return ($null -ne $Value -and $Value.PSObject.TypeNames[0] -eq 'CalicoJsonNumber') }

  function Stop-Json { param($St, [string]$What) Fail "cannot parse $($St.Path): $What at character $($St.I)" }

  function Skip-JsonSpace {
    param($St)
    while ($St.I -lt $St.T.Length) {
      $c = [int]$St.T[$St.I]
      if ($c -ne 0x20 -and $c -ne 0x09 -and $c -ne 0x0A -and $c -ne 0x0D) { return }
      $St.I++
    }
  }

  function Enter-JsonLevel {
    param($St)
    $St.D++
    if ($St.D -gt $JsonMaxDepth) { Stop-Json $St "nesting deeper than $JsonMaxDepth levels" }
  }

  # Every function that can return a List does so as `,$list`: PowerShell
  # would otherwise unroll it into its elements on the way out.
  function Read-JsonValue {
    param($St)
    Skip-JsonSpace $St
    if ($St.I -ge $St.T.Length) { Stop-Json $St 'unexpected end of input' }
    $c = $St.T[$St.I]
    if ($c -eq [char]'{') { return (Read-JsonObject $St) }
    if ($c -eq [char]'[') { return , (Read-JsonArray $St) }
    if ($c -eq [char]'"') { return (Read-JsonString $St) }
    if ([string]::CompareOrdinal($St.T, $St.I, 'true', 0, 4) -eq 0) { $St.I += 4; return $true }
    if ([string]::CompareOrdinal($St.T, $St.I, 'false', 0, 5) -eq 0) { $St.I += 5; return $false }
    if ([string]::CompareOrdinal($St.T, $St.I, 'null', 0, 4) -eq 0) { $St.I += 4; return $null }
    $m = $NumberPattern.Match($St.T, $St.I)
    if ($m.Success -and $m.Length -gt 0) { $St.I += $m.Length; return (New-JsonNumber $m.Value) }
    Stop-Json $St "unexpected character '$c'"
  }

  function Read-JsonObject {
    param($St)
    Enter-JsonLevel $St
    $St.I++
    $obj = New-JsonObject
    Skip-JsonSpace $St
    if ($St.I -lt $St.T.Length -and $St.T[$St.I] -eq [char]'}') { $St.I++; $St.D--; return $obj }
    while ($true) {
      Skip-JsonSpace $St
      if ($St.I -ge $St.T.Length -or $St.T[$St.I] -ne [char]'"') { Stop-Json $St 'expected a string key' }
      $key = Read-JsonString $St
      if ($obj.Contains($key)) { Stop-Json $St "duplicate key '$key'" }
      Skip-JsonSpace $St
      if ($St.I -ge $St.T.Length -or $St.T[$St.I] -ne [char]':') { Stop-Json $St "expected ':'" }
      $St.I++
      $value = Read-JsonValue $St
      $obj.Add($key, $value)
      Skip-JsonSpace $St
      if ($St.I -ge $St.T.Length) { Stop-Json $St 'unterminated object' }
      $c = $St.T[$St.I]
      $St.I++
      if ($c -eq [char]'}') { break }
      if ($c -ne [char]',') { Stop-Json $St "expected ',' or '}'" }
    }
    $St.D--
    return $obj
  }

  function Read-JsonArray {
    param($St)
    Enter-JsonLevel $St
    $St.I++
    $list = New-Object System.Collections.Generic.List[object]
    Skip-JsonSpace $St
    if ($St.I -lt $St.T.Length -and $St.T[$St.I] -eq [char]']') { $St.I++; $St.D--; return , $list }
    while ($true) {
      $value = Read-JsonValue $St
      $list.Add($value)
      Skip-JsonSpace $St
      if ($St.I -ge $St.T.Length) { Stop-Json $St 'unterminated array' }
      $c = $St.T[$St.I]
      $St.I++
      if ($c -eq [char]']') { break }
      if ($c -ne [char]',') { Stop-Json $St "expected ',' or ']'" }
    }
    $St.D--
    return , $list
  }

  function Read-JsonString {
    param($St)
    $t = $St.T
    $i = $St.I + 1
    $sb = New-Object System.Text.StringBuilder
    while ($true) {
      if ($i -ge $t.Length) { $St.I = $i; Stop-Json $St 'unterminated string' }
      $c = $t[$i]
      $code = [int]$c
      if ($code -eq 0x22) { break }
      if ($code -lt 0x20) { $St.I = $i; Stop-Json $St 'control character in a string' }
      if ($code -ne 0x5C) { [void]$sb.Append($c); $i++; continue }
      $i++
      if ($i -ge $t.Length) { $St.I = $i; Stop-Json $St 'unterminated string' }
      switch -CaseSensitive ([string]$t[$i]) {
        '"' { [void]$sb.Append('"') }
        '\' { [void]$sb.Append('\') }
        '/' { [void]$sb.Append('/') }
        'b' { [void]$sb.Append([char]8) }
        'f' { [void]$sb.Append([char]12) }
        'n' { [void]$sb.Append([char]10) }
        'r' { [void]$sb.Append([char]13) }
        't' { [void]$sb.Append([char]9) }
        'u' {
          if ($i + 4 -ge $t.Length -or $t.Substring($i + 1, 4) -notmatch '^[0-9A-Fa-f]{4}\z') { $St.I = $i; Stop-Json $St 'invalid \u escape' }
          [void]$sb.Append([char][Convert]::ToInt32($t.Substring($i + 1, 4), 16))
          $i += 4
        }
        default { $St.I = $i; Stop-Json $St 'invalid escape' }
      }
      $i++
    }
    $St.I = $i + 1
    return $sb.ToString()
  }

  function ConvertFrom-StrictJson {
    param([string]$Text, [string]$Path)
    $st = @{ T = $Text; I = 0; D = 0; Path = $Path }
    $value = Read-JsonValue $st
    Skip-JsonSpace $st
    if ($st.I -lt $st.T.Length) { Stop-Json $st 'unexpected text after the JSON value' }
    return , $value
  }

  # The same escaping as Python's json.dumps(ensure_ascii=False), which the
  # macOS/Linux installer uses, and the same layout for indent=2.
  function Write-JsonString {
    param($Sb, [string]$Text)
    [void]$Sb.Append('"')
    foreach ($c in $Text.ToCharArray()) {
      $code = [int]$c
      if ($code -eq 0x22) { [void]$Sb.Append('\"') }
      elseif ($code -eq 0x5C) { [void]$Sb.Append('\\') }
      elseif ($code -eq 0x0A) { [void]$Sb.Append('\n') }
      elseif ($code -eq 0x0D) { [void]$Sb.Append('\r') }
      elseif ($code -eq 0x09) { [void]$Sb.Append('\t') }
      elseif ($code -eq 0x08) { [void]$Sb.Append('\b') }
      elseif ($code -eq 0x0C) { [void]$Sb.Append('\f') }
      elseif ($code -lt 0x20) { [void]$Sb.Append(('\u{0:x4}' -f $code)) }
      else { [void]$Sb.Append($c) }
    }
    [void]$Sb.Append('"')
  }

  function Write-JsonValue {
    param($Sb, $Value, [int]$Level, [bool]$Pretty)
    if ($null -eq $Value) { [void]$Sb.Append('null'); return }
    if ($Value -is [bool]) { [void]$Sb.Append($(if ($Value) { 'true' } else { 'false' })); return }
    if ($Value -is [string]) { Write-JsonString $Sb $Value; return }
    if (Test-JsonNumber $Value) { [void]$Sb.Append($Value.Text); return }
    $isObject = $Value -is [System.Collections.Specialized.OrderedDictionary]
    if (-not $isObject -and $Value -isnot [System.Collections.Generic.List[object]]) { Fail "cannot write a value of type $($Value.GetType().FullName)" }
    # Keys by method, not property: a JSON key named "Keys" or "Count" would
    # otherwise shadow the dictionary's own property.
    if ($Value.get_Count() -eq 0) { [void]$Sb.Append($(if ($isObject) { '{}' } else { '[]' })); return }
    $items = if ($isObject) { @($Value.get_Keys()) } else { @(0..($Value.Count - 1)) }
    [void]$Sb.Append($(if ($isObject) { '{' } else { '[' }))
    $first = $true
    foreach ($item in $items) {
      if (-not $first) { [void]$Sb.Append(',') }
      $first = $false
      if ($Pretty) { [void]$Sb.Append("`n").Append(' ' * (2 * ($Level + 1))) }
      if ($isObject) {
        Write-JsonString $Sb $item
        [void]$Sb.Append($(if ($Pretty) { ': ' } else { ':' }))
      }
      Write-JsonValue $Sb $Value[$item] ($Level + 1) $Pretty
    }
    if ($Pretty) { [void]$Sb.Append("`n").Append(' ' * (2 * $Level)) }
    [void]$Sb.Append($(if ($isObject) { '}' } else { ']' }))
  }

  function ConvertTo-StrictJson {
    param($Value, [bool]$Pretty)
    $sb = New-Object System.Text.StringBuilder
    Write-JsonValue $sb $Value 0 $Pretty
    return $sb.ToString()
  }

  # --- settings.json ------------------------------------------------------------

  function Read-BytesOrNull {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) { return $null }
    return , [IO.File]::ReadAllBytes($Path)
  }

  function Test-SameBytes {
    param($A, $B)
    if ($null -eq $A -or $null -eq $B) { return ($null -eq $A -and $null -eq $B) }
    return ([Convert]::ToBase64String($A) -ceq [Convert]::ToBase64String($B))
  }

  # The file a symlinked settings.json points to, so the link stays a link and
  # its target is what gets rewritten. A reparse point that reports no link
  # target is treated as the file itself.
  function Resolve-RealPath {
    param([string]$Path)
    $p = $Path
    for ($n = 0; $n -lt 40; $n++) {
      $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
      if (-not $item -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $p }
      $target = @($item.Target) | Select-Object -First 1
      if (-not $target) { return $p }
      if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $p) $target }
      $p = [IO.Path]::GetFullPath($target)
    }
    Fail "too many symbolic links resolving $Path"
  }

  # A new file only: CreateNew never replaces anything, and Flush($true) asks
  # the OS to write the bytes to disk (FlushFileBuffers) before the rename that
  # follows makes them visible.
  function Write-NewFile {
    param([string]$Path, [byte[]]$Bytes)
    $fs = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $fs.Write($Bytes, 0, $Bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  }

  # Moves a finished temp file over its destination in one step. File.Replace
  # keeps the destination's ACL (measured on 5.1 and 7); File.Move is used when
  # there is no destination yet, and fails rather than overwrite one that
  # appeared in the meantime.
  function Move-Into {
    param([string]$Source, [string]$Destination)
    if (Test-Path -LiteralPath $Destination) { [IO.File]::Replace($Source, $Destination, [NullString]::Value) }
    else { [IO.File]::Move($Source, $Destination) }
  }

  # Protected DACL with one rule, FullControl for the current user: the Windows
  # counterpart of mode 0600.
  function Set-OwnerOnlyAcl {
    param([string]$Path)
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  function Test-CalicoHook {
    param($Hook)
    return ($Hook -is [System.Collections.Specialized.OrderedDictionary] -and $Hook['command'] -is [string] -and $Hook['command'].Contains($Marker))
  }

  # One function for both directions, so install and uninstall share the parse,
  # the comparison and the write path. Returns the backup path when it wrote one.
  #
  #   install:   every SessionStart hook whose command references
  #              `.claude/calico/update.` is Calico's. The first is replaced in
  #              place by the current entry; any others are removed. With none,
  #              a new matcher group is appended.
  #   uninstall: every such hook is removed. A group, the SessionStart array or
  #              the hooks object that the removal empties is removed with it.
  #
  # Nothing else is touched, and key order is kept. A missing or blank file
  # reads as {}. When the result is the same as the input the file is not
  # rewritten at all. Otherwise the new text is written BOM-less to a temp file
  # beside the real file (symlinks are followed), the previous bytes are staged
  # as the backup with an owner-only ACL, the file is read again and must still
  # hold the bytes that were parsed, and then the backup and the new file are
  # renamed into place.
  function Update-Settings {
    param([string]$Mode, [string]$HookCommand)
    $real = Resolve-RealPath $Settings
    $raw = Read-BytesOrNull $real
    $text = ''
    if ($null -ne $raw) {
      $offset = 0
      if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) { $offset = 3 }
      try { $text = $Utf8Strict.GetString($raw, $offset, $raw.Length - $offset) }
      catch { Fail "$real is not valid UTF-8" }
    }
    $data = New-JsonObject
    if ($text.Trim().Length -gt 0) { $data = ConvertFrom-StrictJson $text $real }
    if ($data -isnot [System.Collections.Specialized.OrderedDictionary]) { Fail "$real does not hold a JSON object" }
    $before = ConvertTo-StrictJson $data $false

    $hooks = $data['hooks']
    if ($null -ne $hooks -and $hooks -isnot [System.Collections.Specialized.OrderedDictionary]) { Fail "${real}: `"hooks`" is not an object" }
    $groups = $null
    if ($null -ne $hooks) { $groups = $hooks['SessionStart'] }
    if ($null -ne $groups -and $groups -isnot [System.Collections.Generic.List[object]]) { Fail "${real}: `"hooks.SessionStart`" is not an array" }

    $entry = New-JsonObject
    $entry['type'] = 'command'
    $entry['command'] = $HookCommand
    $entry['timeout'] = New-JsonNumber '10'
    $entry['async'] = $true
    $placed = $false
    $kept = New-Object System.Collections.Generic.List[object]
    if ($null -ne $groups) {
      foreach ($group in $groups) {
        if ($group -is [System.Collections.Specialized.OrderedDictionary] -and $group['hooks'] -is [System.Collections.Generic.List[object]]) {
          $inner = New-Object System.Collections.Generic.List[object]
          $removed = $false
          foreach ($hook in $group['hooks']) {
            if (Test-CalicoHook $hook) {
              $removed = $true
              if ($Mode -eq 'install' -and -not $placed) { $inner.Add($entry); $placed = $true }
              continue
            }
            $inner.Add($hook)
          }
          if ($removed -and $inner.Count -eq 0) { continue }
          $group['hooks'] = $inner
        }
        $kept.Add($group)
      }
    }

    if ($Mode -eq 'install') {
      if (-not $placed) {
        $group = New-JsonObject
        $list = New-Object System.Collections.Generic.List[object]
        $list.Add($entry)
        $group['hooks'] = $list
        $kept.Add($group)
      }
      if ($null -eq $hooks) {
        $hooks = New-JsonObject
        $hooks['SessionStart'] = $kept
        $data['hooks'] = $hooks
      } else {
        $hooks['SessionStart'] = $kept
      }
    } elseif ($null -ne $groups) {
      if ($kept.Count -gt 0 -or $groups.Count -eq 0) {
        $hooks['SessionStart'] = $kept
      } else {
        $hooks.Remove('SessionStart')
        if ($hooks.get_Count() -eq 0) { $data.Remove('hooks') }
      }
    }

    # Also covers uninstall with no file: nothing to remove, so nothing is created.
    if ((ConvertTo-StrictJson $data $false) -ceq $before) { return '' }

    try { $bytes = $Utf8Strict.GetBytes((ConvertTo-StrictJson $data $true) + "`n") }
    catch { Fail "$real holds text that cannot be written back as UTF-8 unchanged (an unpaired surrogate escape)" }
    $dir = Split-Path -Parent $real
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = Join-Path $dir ('.settings.json.calico-' + [guid]::NewGuid().ToString('N'))
    $stage = $null
    $backup = ''
    try {
      Write-NewFile $tmp $bytes
      if ($null -ne $raw) {
        $stage = Join-Path $dir ('.settings.json.calico-bak-' + [guid]::NewGuid().ToString('N'))
        Write-NewFile $stage $raw
        Set-OwnerOnlyAcl $stage
      }
      if (-not (Test-SameBytes (Read-BytesOrNull $real) $raw)) {
        Fail "$real changed while it was being updated; nothing was written. Run the installer again."
      }
      if ($null -ne $raw) {
        $backup = "$real.calico-bak"
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
        [IO.File]::Move($stage, $backup)
        $stage = $null
      }
      Move-Into $tmp $real
      $tmp = $null
    } finally {
      foreach ($leftover in @($tmp, $stage)) {
        if ($leftover -and (Test-Path -LiteralPath $leftover)) { Remove-Item -LiteralPath $leftover -Force -ErrorAction SilentlyContinue }
      }
    }
    return $backup
  }

  # --- network ------------------------------------------------------------------

  function Get-ApiToken {
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
    if ($env:GH_TOKEN) { return $env:GH_TOKEN }
    if (Get-Command gh -ErrorAction SilentlyContinue) {
      # Anonymous calls are capped at 60 an hour per address, and a shared
      # egress spends that for everyone behind it. Success is the exit code:
      # an unauthenticated gh exits 1.
      $ErrorActionPreference = 'Continue'
      $token = (& gh auth token 2>$null) -join ''
      if ($LASTEXITCODE -eq 0 -and $token) { return $token.Trim() }
    }
    return ''
  }

  # One API call turns the ref into a commit SHA; the updater is then fetched by
  # SHA. The request is made in-process, so the token is on no command line.
  function Resolve-SourceCommit {
    $headers = @{ 'Accept' = 'application/vnd.github.sha'; 'User-Agent' = 'calico-claude-installer' }
    $token = Get-ApiToken
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    try { $answer = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$SourceRef" -Headers $headers }
    catch { Fail "Could not resolve $Repo@$SourceRef to a commit: $($_.Exception.Message)" }
    $sha = "$answer".Trim()
    if ($sha -cnotmatch '^[0-9a-f]{40}\z') { Fail "GitHub returned something other than a commit SHA for $Repo@$SourceRef." }
    return $sha
  }

  # Raw file downloads never carry the token.
  function Save-SourceFile {
    param([string]$RelPath, [string]$OutFile)
    try { Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$Repo/$($S.Sha)/$RelPath" -OutFile $OutFile -UseBasicParsing -Headers @{ 'User-Agent' = 'calico-claude-installer' } }
    catch { Fail "Could not download $RelPath at $($S.Sha): $($_.Exception.Message)" }
    if (-not (Test-Path -LiteralPath $OutFile -PathType Leaf) -or (Get-Item -LiteralPath $OutFile).Length -eq 0) { Fail "Downloaded $RelPath at $($S.Sha) is empty." }
  }

  # --- install steps ------------------------------------------------------------

  function Install-Updater {
    param([string]$Downloaded)
    $S.Hint = $S.UninstallCmd
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    # Through a rename, like every other file here, so a hook-started updater
    # reading the old file never sees a half-written one.
    $tmp = Join-Path $StateDir ('.update.ps1.' + [guid]::NewGuid().ToString('N'))
    try {
      Write-NewFile $tmp ([IO.File]::ReadAllBytes($Downloaded))
      Move-Into $tmp $Updater
    } finally {
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    [IO.File]::WriteAllText((Join-Path $StateDir 'config'), "repo=$Repo`r`n")
    [IO.File]::WriteAllText((Join-Path $StateDir 'source-commit'), "$($S.Sha)`r`n")
  }

  # The interactive updater honours CALICO_* path overrides; the hook and the
  # task do not. Clearing them for this one run keeps the install where those
  # will look, and CALICO_REPO is the repo just written to the config. The
  # updater always runs under Windows PowerShell 5.1, as the hook and the task
  # do, and in its own process, because it ends with `exit`.
  function Invoke-Updater {
    Say "Installing calico-claude with the updater ($Repo)..."
    $names = @('CALICO_REPO', 'CALICO_BIN_LINK', 'CALICO_VERSIONS_DIR', 'CALICO_STATE_DIR')
    $saved = @{}
    foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
    $ErrorActionPreference = 'Continue'
    $rc = $null
    try {
      foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $null) }
      [Environment]::SetEnvironmentVariable('CALICO_REPO', $Repo)
      & $WinPowerShell -NoProfile -ExecutionPolicy Bypass -File $Updater -Mode force 2>&1 | ForEach-Object { Say "$_" }
      $rc = $LASTEXITCODE
    } finally {
      foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
    }
    if ($rc -ne 0) { Fail "The updater could not install calico-claude (exit $rc; see its output above)." }
    if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
      Fail "The updater finished but $Launcher is missing; another update may still be running. Run this installer again in a minute."
    }
  }

  # Hourly, as the current user, in that user's logon session (Interactive: no
  # password is stored, and it runs only while the user is signed in), with the
  # limited token even for an administrator. The first run is an hour out: the
  # updater has just run. -Force replaces an earlier registration in place.
  function Register-UpdateTask {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $TaskExe -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode unattended-run' -f $Updater)
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1)
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    # Without these the task does not start on battery power, and a hung run
    # would block every later one for the default 72 hours.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    try {
      Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    } catch {
      Fail "Could not register the scheduled task $TaskPath${TaskName}: $($_.Exception.Message)"
    }
  }

  # The official claude is never touched. An earlier version of this installer
  # wrote over it, and those builds do not update themselves, so say how to get
  # the official one back.
  function Show-PatchedOfficial {
    $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return }
    $ErrorActionPreference = 'Continue'
    $version = (@(& $cmd.Source --version 2>&1) | ForEach-Object { "$_" }) -join ' '
    if (-not $version.Contains('(patched)')) { return }
    Say ''
    Say "Note: $($cmd.Source) reports '$version'."
    Say 'An earlier version of this installer replaced the official claude.exe with a Calico build.'
    Say "It was left untouched. To restore the official build, run Anthropic's installer, then"
    Say 'check that `claude --version` no longer prints (patched):'
    Say '  irm https://claude.ai/install.ps1 | iex'
  }

  function Get-InstalledTag {
    $record = Join-Path $StateDir 'installed-tag'
    if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { return '' }
    foreach ($line in [IO.File]::ReadAllLines($record)) {
      if ($line -cmatch '^tag=(\S+)\z') { return $Matches[1] }
    }
    return ''
  }

  function Invoke-Install {
    $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ('calico-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    try {
      $S.Sha = Resolve-SourceCommit
      $S.UninstallCmd = "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/$Repo/$($S.Sha)/install-patched-claude.ps1))) -Uninstall"
      Say "Installing from $Repo at $($S.Sha)"
      $downloaded = Join-Path $tmpDir 'update.ps1'
      Save-SourceFile 'examples/local-auto-update/update.ps1' $downloaded
      Install-Updater $downloaded
    } finally {
      Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Invoke-Updater

    try { $backup = Update-Settings 'install' $HookCommand }
    catch {
      Fail ("$($_.Exception.Message)`nCould not add the SessionStart hook to $Settings; it was left unchanged. " +
        "To wire it by hand, add this group to the hooks.SessionStart array:`n  " +
        '{"hooks": [{"type": "command", "command": ' + (ConvertTo-StrictJson $HookCommand $false) + ', "timeout": 10, "async": true}]}')
    }
    Register-UpdateTask
    Show-PatchedOfficial

    Say ''
    Say "Installed calico-claude from $Repo at $($S.Sha)."
    $tag = Get-InstalledTag
    if ($tag) { Say "Release: $tag" }
    Say ''
    Say 'Created or updated:'
    Say "  $Launcher  (the launcher; run Calico with this name)"
    Say "  $ShareDir\versions\  (installed builds)"
    Say "  $Updater  (updater)"
    Say "  $StateDir\config  (repo=$Repo)"
    Say "  $StateDir\source-commit  ($($S.Sha))"
    Say "  $StateDir\  (also the updater's log, install record and throttle stamp)"
    Say "  $Settings  (SessionStart hook: $HookCommand)"
    if ($backup) { Say "  $backup  (settings.json as it was before this run, readable by you only)" }
    Say "  Task Scheduler $TaskPath$TaskName  (hourly, runs update.ps1 -Mode unattended-run as $([Security.Principal.WindowsIdentity]::GetCurrent().Name), not elevated)"
    Say ''
    Say 'The official claude.exe was not modified.'
    Say ''
    Say 'To uninstall:'
    Say "  $($S.UninstallCmd)"
  }

  # --- uninstall ----------------------------------------------------------------

  # The launcher is a plain copy, so the updater's record (the SHA256 of the
  # build it installed) is the only proof that it is ours to delete.
  function Remove-Launcher {
    $bin = Split-Path -Parent $Launcher
    if (Test-Path -LiteralPath $Launcher) {
      $recorded = ''
      $record = Join-Path $StateDir 'installed-tag'
      if (Test-Path -LiteralPath $record -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($record)) {
          if ($line -cmatch '^sha256=([0-9A-Fa-f]{64})\z') { $recorded = $Matches[1] }
        }
      }
      if ($recorded -and (Get-FileHash -LiteralPath $Launcher -Algorithm SHA256).Hash -eq $recorded) {
        try { Remove-Item -LiteralPath $Launcher -Force }
        catch { Fail "Could not remove $Launcher ($($_.Exception.Message)). Close every running calico-claude session, then run the uninstall command again." }
      } else {
        Say "Left $Launcher in place: it is not the build the updater recorded installing."
      }
    }
    if (Test-Path -LiteralPath $bin) {
      foreach ($file in @(Get-ChildItem -LiteralPath $bin -File)) {
        if ($file.Name.StartsWith('calico-claude.exe.calico-old.') -or $file.Name.StartsWith('calico-claude.exe.calico-new.')) {
          try { Remove-Item -LiteralPath $file.FullName -Force }
          catch { Say "Left $($file.FullName) in place (still in use); delete it once no calico-claude session runs it." }
        }
      }
    }
  }

  # Through the Task Scheduler COM API. An earlier version checked first with
  # Get-ScheduledTask -ErrorAction SilentlyContinue, and once, with eight test
  # suites registering tasks at the same time, an uninstall exited 0 and left
  # the task registered (inferred, not traced: that check came back empty, and
  # the option hid why). Here only "not found" (0x80070002, measured for a
  # missing folder and for a missing task) counts as already gone; any other
  # error fails the uninstall.
  function Remove-UpdateTask {
    $notFound = -2147024894  # 0x80070002
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    try { $folder = $service.GetFolder($TaskPath.TrimEnd('\')) }
    catch { if ($_.Exception.HResult -eq $notFound) { return }; throw }
    try { $folder.DeleteTask($TaskName, 0) }
    catch { if ($_.Exception.HResult -ne $notFound) { throw } }
    # The folder too, when nothing else is in it; deleting a folder that still
    # holds a task fails, and that failure is the check.
    try { $service.GetFolder('\').DeleteFolder($TaskPath.Trim('\'), 0) } catch { }
  }

  # Removes only what Invoke-Install creates. The official claude, other hooks
  # and the rest of settings.json are left alone, and so is settings.json.calico-bak.
  function Invoke-Uninstall {
    # The settings file goes first: it is the one step that can refuse (a file
    # that does not parse), and a refusal should leave everything else in place.
    try { $backup = Update-Settings 'uninstall' $HookCommand }
    catch { Fail "$($_.Exception.Message)`nCould not remove the SessionStart hook from $Settings; nothing was removed." }

    Remove-UpdateTask

    Remove-Launcher
    foreach ($dir in @($ShareDir, $StateDir)) {
      if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }

    Say 'Removed calico-claude, its builds, the updater and its state, and the SessionStart hook.'
    Say "Removed the scheduled task $TaskPath$TaskName."
    if ($backup) { Say "settings.json before this change: $backup" }
    Show-PatchedOfficial
  }

  # --- main ---------------------------------------------------------------------

  try {
    if ($env:OS -ne 'Windows_NT') {
      Fail "This is the Windows installer. On macOS and Linux, run:`n  curl -fsSL https://raw.githubusercontent.com/$Repo/main/install-patched-claude.sh | bash"
    }
    Assert-NotElevated
    Assert-Inputs

    # Paths the updater itself derives from USERPROFILE in its unattended modes.
    # They are not configurable here for the same reason they are not there:
    # the hook and the task must manage exactly what this installer installed.
    $StateDir = Join-Path $env:USERPROFILE '.claude\calico'
    $Updater = Join-Path $StateDir 'update.ps1'
    $Launcher = Join-Path $env:USERPROFILE '.local\bin\calico-claude.exe'
    $ShareDir = Join-Path $env:USERPROFILE '.local\share\calico-claude'
    $Settings = Join-Path $env:USERPROFILE '.claude\settings.json'
    $TaskName = 'auto-update-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    # A plain exe invocation: Claude Code runs hook commands under Git Bash
    # (measured with Calico 2.1.280 on Windows 11; this exact line ran from a
    # real 2.1.281 session). Forward slashes, which powershell.exe -File takes,
    # so the entry carries the same `.claude/calico/update.` marker that both
    # installers use to find their own entry.
    $HookCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode hook' -f ($Updater -replace '\\', '/')

    if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
    $global:LASTEXITCODE = 0
  } catch {
    Say "Error: $($_.Exception.Message)"
    if ($S.Hint) {
      Say ''
      Say 'To remove what this run already installed:'
      Say "  $($S.Hint)"
    }
    if ($AsFile) { exit 1 }
    $global:LASTEXITCODE = 1
  }
} $Uninstall.IsPresent ($MyInvocation.MyCommand.CommandType -eq 'ExternalScript')
