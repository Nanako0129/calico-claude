#!/usr/bin/env bash
#
# Offline suite for install-patched-claude.sh (the macOS/Linux bootstrapper).
#
# Every case runs the real installer in a sandbox HOME with stubs for curl, gh,
# launchctl, id and uname first on PATH, and a stand-in updater served in place
# of update.sh. Nothing reaches the network, the real ~/.claude, or the real
# launchd domain: the launchctl stub records its arguments instead, and the
# launchd label is overridden to a test label as a second line of defence.
#
# The installer runs under the bash running this file, so run the suite once
# with each shell:
#   /bin/bash examples/local-auto-update/test-install.sh   # macOS stock 3.2
#   bash examples/local-auto-update/test-install.sh        # current bash
#
# INSTALLER_UNDER_TEST points the suite at a copy (mutation runs).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALLER="${INSTALLER_UNDER_TEST:-${REPO_ROOT}/install-patched-claude.sh}"
TEMPLATE="${SCRIPT_DIR}/com.calico.auto-update.plist"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}
contains() { # contains <description> <needle> <file>
  if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 (no [$2] in: $(tr '\n' ' ' < "$3"))"; fi
}

printf 'installer under test: %s\nshell: %s %s\n\n' "$INSTALLER" "$BASH" "$BASH_VERSION"

FAKE_SHA="0123456789abcdef0123456789abcdef01234567"
TEST_LABEL="com.calico.auto-update.test-install"
H="${SANDBOX}/home"
OUT="${SANDBOX}/out.txt"
URLS="${SANDBOX}/urls.log"
AUTH="${SANDBOX}/auth.log"
LC_LOG="${SANDBOX}/launchctl.log"
LC_DIR="${SANDBOX}/launchd-state"
UPD_LOG="${SANDBOX}/updater.log"
SETTINGS="${H}/.claude/settings.json"

# --- stubs --------------------------------------------------------------------
STUB="${SANDBOX}/stub-bin"
mkdir -p "$STUB"
# python3 comes from the caller's PATH; everything else on the installer's PATH
# is a stub or a system directory, so no real gh, claude or launchctl is reached.
ln -s "$(command -v python3)" "${STUB}/python3"

cat > "${STUB}/curl" <<'SH'
#!/bin/sh
# Serves the commit lookup and the two source files by URL, records every URL,
# and records which Authorization header arrived and how (stdin vs argv).
out=""; url=""; prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  if [ "$prev" = "-H" ]; then
    case "$arg" in
      @-) while IFS= read -r line; do
            case "$line" in Authorization:*) printf '%s\n' "$line" >> "$FAKE_AUTH_LOG" ;; esac
          done ;;
      Authorization:*) printf 'ARGV-LEAK %s\n' "$arg" >> "$FAKE_AUTH_LOG" ;;
    esac
  fi
  case "$arg" in http*) url="$arg" ;; esac
  prev="$arg"
done
printf '%s\n' "$url" >> "$FAKE_URL_LOG"
[ -n "$out" ] || exit 2
case "$url" in
  https://api.github.com/repos/*/commits/*) printf '%s\n' "$FAKE_SHA" > "$out" ;;
  https://raw.githubusercontent.com/*/examples/local-auto-update/update.sh) cat "$FAKE_UPDATER" > "$out" ;;
  https://raw.githubusercontent.com/*/examples/local-auto-update/com.calico.auto-update.plist) cat "$FAKE_PLIST" > "$out" ;;
  *) exit 22 ;;
esac
SH

cat > "${STUB}/gh" <<'SH'
#!/bin/sh
# Unauthenticated unless FAKE_GH_TOKEN is set.
if [ "$1" = "auth" ] && [ "$2" = "token" ] && [ -n "$FAKE_GH_TOKEN" ]; then echo "$FAKE_GH_TOKEN"; exit 0; fi
exit 1
SH

cat > "${STUB}/launchctl" <<'SH'
#!/bin/sh
# Stateful stand-in for the gui domain, with the exit codes measured on macOS
# 26: bootout of an absent label exits 3, bootstrap over a loaded one exits 5,
# print of an absent one exits 113.
printf '%s\n' "$*" >> "$FAKE_LC_LOG"
loaded="$FAKE_LC_DIR/loaded"
case "$1" in
  bootout)
    [ "${FAKE_LC_BOOTOUT_FAIL:-0}" = 1 ] && { echo "Boot-out failed: 5: Input/output error" >&2; exit 5; }
    [ -e "$loaded" ] || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }
    rm -f "$loaded"; exit 0 ;;
  bootstrap)
    [ "${FAKE_LC_BOOTSTRAP_FAIL:-0}" = 1 ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    [ -e "$loaded" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    printf '%s\n' "$3" > "$loaded"; exit 0 ;;
  print)
    [ -e "$loaded" ] || exit 113
    echo "path = $(cat "$loaded")"; exit 0 ;;
esac
exit 64
SH

cat > "${STUB}/id" <<'SH'
#!/bin/sh
if [ "$1" = "-u" ]; then echo "${FAKE_UID:-501}"; exit 0; fi
exec /usr/bin/id "$@"
SH

cat > "${STUB}/uname" <<'SH'
#!/bin/sh
case "$1" in
  -s) echo "${FAKE_UNAME_S:-Darwin}" ;;
  -m) echo arm64 ;;
  *) exec /usr/bin/uname "$@" ;;
esac
SH
chmod +x "${STUB}"/*

# Served as update.sh. Records how it was called, then does what --force does
# to the filesystem: a versioned build and the launcher symlink.
FAKE_UPDATER="${SANDBOX}/fake-update.sh"
cat > "$FAKE_UPDATER" <<'SH'
#!/bin/bash
printf '%s|repo=%s|link=%s\n' "$*" "${CALICO_REPO:-}" "${CALICO_BIN_LINK:-unset}" >> "$FAKE_UPDATER_LOG"
[ "${FAKE_UPDATER_RC:-0}" = 0 ] || exit "$FAKE_UPDATER_RC"
[ -z "$FAKE_UPDATER_NOLINK" ] || exit 0
mkdir -p "$HOME/.local/share/calico-claude/versions" "$HOME/.local/bin"
printf '#!/bin/sh\necho "9.9.9 (Claude Code) (patched)"\n' > "$HOME/.local/share/calico-claude/versions/9.9.9"
chmod +x "$HOME/.local/share/calico-claude/versions/9.9.9"
ln -sfn "$HOME/.local/share/calico-claude/versions/9.9.9" "$HOME/.local/bin/calico-claude"
SH

# A stand-in official claude, for the "(patched)" notice cases.
CLAUDE_BIN="${SANDBOX}/claude-bin"
mkdir -p "$CLAUDE_BIN"

# Injected between the installer's read of settings.json and its rename: every
# os.fsync (the installer calls it once, on the temp file) first appends to the
# file named by FAKE_CONCURRENT_WRITE, as another writer would.
CONCURRENT="${SANDBOX}/concurrent"
mkdir -p "$CONCURRENT"
cat > "${CONCURRENT}/sitecustomize.py" <<'PY'
import os
_fsync = os.fsync
def fsync(fd):
    target = os.environ.get("FAKE_CONCURRENT_WRITE")
    if target:
        with open(target, "ab") as handle:
            handle.write(b" ")
    return _fsync(fd)
os.fsync = fsync
PY

# --- harness ------------------------------------------------------------------
reset() {
  rm -rf "$H" "$LC_DIR"
  mkdir -p "${H}/.claude" "$LC_DIR"
  : > "$URLS"; : > "$AUTH"; : > "$LC_LOG"; : > "$UPD_LOG"
}

# Runs the installer with a clean environment plus whatever VAR=value the
# caller puts in front. Echoes the exit status; output goes to $OUT.
run() {
  env -u GH_TOKEN -u GITHUB_TOKEN -u PATCH_CLAUDE_REPO -u CALICO_REPO -u CALICO_SOURCE_REF \
      -u CALICO_BIN_LINK -u PYTHONPATH \
    HOME="$H" PATH="${EXTRA_PATH:-}${STUB}:/usr/bin:/bin:/usr/sbin:/sbin" \
    CALICO_TEST_LAUNCHD_LABEL="$TEST_LABEL" \
    FAKE_SHA="$FAKE_SHA" FAKE_UPDATER="$FAKE_UPDATER" FAKE_PLIST="$TEMPLATE" \
    FAKE_URL_LOG="$URLS" FAKE_AUTH_LOG="$AUTH" FAKE_LC_LOG="$LC_LOG" FAKE_LC_DIR="$LC_DIR" \
    FAKE_UPDATER_LOG="$UPD_LOG" \
    "$@" "$BASH" "$INSTALLER" ${ARGS:-} > "$OUT" 2>&1
  echo $?
}
install_() { run "$@"; }
uninstall_() { ARGS=--uninstall run "$@"; }

HOOK_CMD="/bin/bash \"${H}/.claude/calico/update.sh\" --hook"

# The comparison contract, used by every settings assertion. A missing or blank
# file reads as {}. Both sides drop every SessionStart hook whose command
# references .claude/calico/update. (and any group that removal empties); a
# SessionStart array, and then a hooks object, that the removal empties is
# dropped too unless the original input had it with content of its own. The
# rest is compared as parsed values, key order included.
CONTRACT="${SANDBOX}/contract.py"
cat > "$CONTRACT" <<'PY'
import copy, json, sys
MARKER = ".claude/calico/update."

def load(path):
    try:
        raw = open(path, "rb").read()
    except FileNotFoundError:
        return {}
    text = raw.decode("utf-8-sig")
    return json.loads(text) if text.strip() else {}

def calico(h):
    return isinstance(h, dict) and isinstance(h.get("command"), str) and MARKER in h["command"]

def strip(x):
    """Returns (copy without Calico hooks, SessionStart emptied, hooks emptied)."""
    x = copy.deepcopy(x)
    hooks = x.get("hooks")
    if not (isinstance(hooks, dict) and isinstance(hooks.get("SessionStart"), list)):
        return x, False, False
    before = hooks["SessionStart"]
    kept = []
    for g in before:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            inner = [h for h in g["hooks"] if not calico(h)]
            if len(inner) != len(g["hooks"]) and not inner:
                continue
            g["hooks"] = inner
        kept.append(g)
    hooks["SessionStart"] = kept
    ss_emptied = bool(before) and not kept
    return x, ss_emptied, ss_emptied and list(hooks) == ["SessionStart"]

def normalise(x, original):
    y, ss_emptied, hooks_emptied = strip(x)
    _, o_ss, o_hooks = strip(original)
    o_has_ss = isinstance(original.get("hooks"), dict) and "SessionStart" in original["hooks"]
    if ss_emptied and (not o_has_ss or o_ss):
        del y["hooks"]["SessionStart"]
        if not y["hooks"] and ("hooks" not in original or o_hooks):
            del y["hooks"]
    return json.dumps(y, ensure_ascii=False)

original, other = load(sys.argv[1]), load(sys.argv[2])
print("equal" if normalise(original, original) == normalise(other, original) else "unequal")
PY
contract() { python3 "$CONTRACT" "$1" "$2"; }

# How many hook entries in the file reference the updater, and the first one's command.
calico_hooks() {
  python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
cmds = [h.get("command") for g in d.get("hooks", {}).get("SessionStart", [])
        for h in (g.get("hooks") or []) if ".claude/calico/update." in str(h.get("command"))]
print("%d|%s" % (len(cmds), cmds[0] if cmds else ""))
PY
}
mode_of() { python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }
leftover_temps() { ls -a "$1" | grep -c '^\.settings\.json\.calico-' ; }

# --- fixtures -----------------------------------------------------------------
FX="${SANDBOX}/fixtures"
mkdir -p "$FX"
printf '{"model": "opus", "permissions": {"allow": ["Bash(ls)"]}, "env": {"A": "1"}}\n' > "${FX}/no-hooks.json"
cat > "${FX}/unrelated.json" <<'JSON'
{
  "zeta": "日本語 ✓ café — naïve",
  "stamp": "2026-09-24T10:00:00Z",
  "hooks": {
    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo pre"}]}],
    "SessionStart": [
      {"matcher": "startup", "hooks": [{"type": "command", "command": "echo 起動"}]},
      {"hooks": [{"type": "command", "command": "~/bin/other-hook", "timeout": 5}]}
    ],
    "Stop": []
  },
  "deep": {"a": {"b": {"c": {"d": {"e": {"f": [1, 2.5, {"g": null, "h": [true, false]}]}}}}}},
  "alpha": 1
}
JSON
cat > "${FX}/stale.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {"matcher": "startup", "hooks": [
        {"type": "command", "command": "echo before"},
        {"type": "command", "command": "bash ~/.claude/calico/update.sh --hook", "timeout": 10, "async": true},
        {"type": "command", "command": "echo after"}]},
      {"hooks": [{"type": "command", "command": "echo unrelated"}]},
      {"hooks": [{"type": "command", "command": "/bin/bash \"/old/home/.claude/calico/update.sh\" --hook"}]}
    ]
  },
  "theme": "dark"
}
JSON
# The same values as unrelated.json, indented and spaced differently.
python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); open(sys.argv[2],"w",encoding="utf-8").write(json.dumps(d,indent=7,ensure_ascii=False,separators=(" ,"," :  ")))' \
  "${FX}/unrelated.json" "${FX}/reindented.json"
# One unrelated hook's command string changed.
sed 's/echo 起動/echo 起動!/' "${FX}/unrelated.json" > "${FX}/changed.json"

# --- 0. the contract itself -----------------------------------------------------
: > "${FX}/empty.json"
check "contract: an empty file equals {}" "equal" "$(printf '{}' > "${FX}/braces.json"; contract "${FX}/empty.json" "${FX}/braces.json")"
check "contract: a missing file equals {}" "equal" "$(contract "${FX}/does-not-exist.json" "${FX}/braces.json")"
check "contract: whitespace and indentation alone compare equal" "equal" "$(contract "${FX}/unrelated.json" "${FX}/reindented.json")"
check "contract: a changed unrelated hook string compares unequal" "unequal" "$(contract "${FX}/unrelated.json" "${FX}/changed.json")"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); d=dict(reversed(list(d.items()))); open(sys.argv[2],"w",encoding="utf-8").write(json.dumps(d,ensure_ascii=False))' \
  "${FX}/unrelated.json" "${FX}/reordered.json"
check "contract: reordered keys compare unequal" "unequal" "$(contract "${FX}/unrelated.json" "${FX}/reordered.json")"

# --- 1. refusals ------------------------------------------------------------------
reset
rc="$(install_ FAKE_UID=0)"
check "root: refused with a non-zero exit" "1" "$rc"
contains "root: says why" "Do not run this installer as root" "$OUT"
check "root: nothing was fetched" "0" "$(wc -l < "$URLS" | tr -d ' ')"
if [[ ! -e "${H}/.claude/calico" && ! -e "$SETTINGS" ]]; then ok "root: nothing was written"; else bad "root: nothing was written"; fi

reset
rc="$(uninstall_ FAKE_UID=0)"
check "root: --uninstall is refused too" "1" "$rc"

for os_name in MINGW64_NT-10.0-26100 MSYS_NT-10.0 CYGWIN_NT-10.0; do
  reset
  rc="$(install_ FAKE_UNAME_S="$os_name")"
  check "$os_name: refused" "1" "$rc"
  contains "$os_name: points to the PowerShell installer" "install-patched-claude.ps1" "$OUT"
  if [[ ! -s "$URLS" && ! -e "${H}/.claude/calico" ]]; then ok "$os_name: nothing fetched or written"; else bad "$os_name: nothing fetched or written"; fi
done

reset
rc="$(install_ FAKE_UNAME_S=FreeBSD)"
check "an unknown OS is refused" "1" "$rc"

reset
rc="$(ARGS=--bogus run)"
check "an unknown argument exits 2" "2" "$rc"

reset
rc="$(install_ CALICO_SOURCE_REF='main;x')"
check "an invalid source ref is refused" "1" "$rc"
reset
rc="$(install_ CALICO_TEST_LAUNCHD_LABEL='../escape')"
check "an invalid launchd label is refused" "1" "$rc"
check "an invalid launchd label fetches nothing" "0" "$(wc -l < "$URLS" | tr -d ' ')"

# HOME goes into the hook command inside double quotes, run by /bin/sh.
for odd in 'a"b' 'a$b' 'a`b' 'a\b'; do
  reset
  mkdir -p "${SANDBOX}/odd/${odd}"
  rc="$(install_ HOME="${SANDBOX}/odd/${odd}")"
  check "HOME containing ${odd#a}: refused" "1" "$rc"
  if [[ -z "$(ls -A "${SANDBOX}/odd/${odd}")" && ! -s "$URLS" ]]; then ok "HOME containing ${odd#a}: nothing written or fetched"; else bad "HOME containing ${odd#a}: nothing written or fetched"; fi
  rm -rf "${SANDBOX}/odd"
done

reset
rc="$(install_ CALICO_REPO='evil/repo;rm')"
check "an invalid repo slug is refused" "1" "$rc"
check "an invalid repo slug fetches nothing" "0" "$(wc -l < "$URLS" | tr -d ' ')"

# --- 2. a fresh macOS install -----------------------------------------------------
reset
rc="$(install_ CALICO_BIN_LINK=/should/not/reach/the/updater)"
check "fresh install exits 0" "0" "$rc"
cp "$OUT" "${SANDBOX}/fresh-out.txt"

# SHA pinning: one API call resolves main, every file comes from that SHA.
check "the first request resolves main through the API" \
  "https://api.github.com/repos/Nanako0129/calico-claude/commits/main" "$(sed -n 1p "$URLS")"
check "exactly one API request" "1" "$(grep -c '^https://api.github.com/' "$URLS")"
check "every other request is a raw file at the SHA (2 on macOS)" "2" \
  "$(grep -c "^https://raw.githubusercontent.com/Nanako0129/calico-claude/${FAKE_SHA}/" "$URLS")"
check "no request other than those three" "3" "$(wc -l < "$URLS" | tr -d ' ')"
check "source-commit records the SHA" "$FAKE_SHA" "$(cat "${H}/.claude/calico/source-commit")"
check "config names the repo" "repo=Nanako0129/calico-claude" "$(cat "${H}/.claude/calico/config")"
if cmp -s "$FAKE_UPDATER" "${H}/.claude/calico/update.sh" && [[ -x "${H}/.claude/calico/update.sh" ]]; then
  ok "the fetched updater is installed, executable"
else bad "the fetched updater is installed, executable"; fi
check "the updater ran once, with --force, the repo, and no CALICO_BIN_LINK" \
  "--force|repo=Nanako0129/calico-claude|link=unset" "$(cat "$UPD_LOG")"
contains "the exact uninstall command is printed" \
  "curl -fsSL https://raw.githubusercontent.com/Nanako0129/calico-claude/${FAKE_SHA}/install-patched-claude.sh | bash -s -- --uninstall" "$OUT"
contains "the footprint lists the hook command" "$HOOK_CMD" "$OUT"
contains "the footprint lists the source commit" "source-commit  (${FAKE_SHA})" "$OUT"
contains "the footprint lists the timer" "gui/501/${TEST_LABEL}" "$OUT"

# settings.json: created from nothing.
check "missing settings.json: one Calico hook, the exact command" "1|${HOOK_CMD}" "$(calico_hooks "$SETTINGS")"
check "missing settings.json: contract-equal to {}" "equal" "$(contract "${FX}/does-not-exist.json" "$SETTINGS")"
check "missing settings.json: created 0600" "600" "$(mode_of "$SETTINGS")"
if [[ ! -e "${SETTINGS}.calico-bak" ]]; then ok "missing settings.json: no backup of nothing"; else bad "missing settings.json: no backup of nothing"; fi
check "the hook entry's full shape" \
  '{"type": "command", "command": "/bin/bash \"'"$H"'/.claude/calico/update.sh\" --hook", "timeout": 10, "async": true}' \
  "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["hooks"]["SessionStart"][0]["hooks"][0]))' "$SETTINGS")"

# launchd: bootout of a never-loaded label, then bootstrap.
check "launchctl: bootout first, then print (absent), then bootstrap" \
  "bootout gui/501/${TEST_LABEL}|print gui/501/${TEST_LABEL}|bootstrap gui/501 ${H}/Library/LaunchAgents/${TEST_LABEL}.plist" \
  "$(paste -sd'|' "$LC_LOG")"
check "the job is loaded from the sandbox plist" "${H}/Library/LaunchAgents/${TEST_LABEL}.plist" "$(cat "${LC_DIR}/loaded")"
PLIST="${H}/Library/LaunchAgents/${TEST_LABEL}.plist"
check "plist: label, program, HOME and log" \
  "${TEST_LABEL}|/bin/bash ${H}/.claude/calico/update.sh --unattended-run|${H}|${H}/Library/Logs/calico-auto-update.log|3600|True" \
  "$(python3 -c '
import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb"))
print("|".join([p["Label"], " ".join(p["ProgramArguments"]), p["EnvironmentVariables"]["HOME"], p["StandardOutPath"], str(p["StartInterval"]), str(p["RunAtLoad"])]))' "$PLIST")"
if grep -q __HOME__ "$PLIST"; then bad "plist: no __HOME__ left"; else ok "plist: no __HOME__ left"; fi

# --- 3. an immediate second install -------------------------------------------------
cp "$SETTINGS" "${SANDBOX}/first.json"
: > "$LC_LOG"
rc="$(install_)"
check "second install exits 0" "0" "$rc"
if cmp -s "$SETTINGS" "${SANDBOX}/first.json"; then ok "second install: settings.json byte-identical"; else bad "second install: settings.json byte-identical"; fi
check "second install: still one Calico hook" "1|${HOOK_CMD}" "$(calico_hooks "$SETTINGS")"
check "second install: bootout of the loaded job, then bootstrap" \
  "bootout gui/501/${TEST_LABEL}|bootstrap gui/501 ${PLIST}" "$(paste -sd'|' "$LC_LOG")"
check "second install: one job, from the same plist" "$PLIST" "$(cat "${LC_DIR}/loaded")"

# --- 4. settings merge fixtures -------------------------------------------------------
merge_case() { # <fixture> <label> ; installs over a copy of the fixture
  reset
  cp "$1" "$SETTINGS"
  rc="$(install_)"
  check "$2: install exits 0" "0" "$rc"
  check "$2: exactly one Calico hook" "1|${HOOK_CMD}" "$(calico_hooks "$SETTINGS")"
  check "$2: contract-equal to the input" "equal" "$(contract "$1" "$SETTINGS")"
  if cmp -s "$1" "${SETTINGS}.calico-bak"; then ok "$2: backup holds the input"; else bad "$2: backup holds the input"; fi
  check "$2: backup is 0600" "600" "$(mode_of "${SETTINGS}.calico-bak")"
  check "$2: no temp file left" "0" "$(leftover_temps "${H}/.claude")"
}
merge_case "${FX}/empty.json" "empty file"
merge_case "${FX}/no-hooks.json" "no hooks key"
check "no hooks key: hooks appended after the existing keys" "model permissions env hooks" \
  "$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))))' "$SETTINGS")"
merge_case "${FX}/unrelated.json" "unrelated hooks, nesting, non-ASCII"
check "unrelated hooks: ours is appended after the existing groups" "echo 起動|~/bin/other-hook|${HOOK_CMD}" \
  "$(python3 -c 'import json,sys; print("|".join(g["hooks"][0]["command"] for g in json.load(open(sys.argv[1],encoding="utf-8"))["hooks"]["SessionStart"]))' "$SETTINGS")"
contains "non-ASCII is written as UTF-8, not escaped" "日本語 ✓ café — naïve" "$SETTINGS"
contains "a date-looking string stays the same string" '"stamp": "2026-09-24T10:00:00Z"' "$SETTINGS"
cp "$SETTINGS" "${SANDBOX}/unrelated-installed.json"
merge_case "${FX}/stale.json" "stale Calico entries"
check "stale: the first stale entry is replaced in place, the second removed" \
  "startup:echo before,${HOOK_CMD},echo after|-:echo unrelated" \
  "$(python3 -c '
import json,sys
print("|".join("%s:%s" % (g.get("matcher","-"), ",".join(h["command"] for h in g["hooks"])) for g in json.load(open(sys.argv[1]))["hooks"]["SessionStart"]))' "$SETTINGS")"

# A file with a UTF-8 BOM is read, and written back without one.
reset
printf '\xef\xbb\xbf{"theme": "dark"}\n' > "$SETTINGS"
cp "$SETTINGS" "${SANDBOX}/bom.json"
rc="$(install_)"
check "BOM input: install exits 0" "0" "$rc"
check "BOM input: output has no BOM" "7b" "$(head -c 1 "$SETTINGS" | od -An -tx1 | tr -d ' \n')"
check "BOM input: contract-equal" "equal" "$(contract "${SANDBOX}/bom.json" "$SETTINGS")"

# The contract must be able to turn this suite red: the installed output with
# one unrelated string changed is not equal to the input.
sed 's/echo 起動/echo 起動!/' "${SANDBOX}/unrelated-installed.json" > "${SANDBOX}/unrelated-tampered.json"
check "contract flags an installed file whose unrelated hook changed" "unequal" \
  "$(contract "${FX}/unrelated.json" "${SANDBOX}/unrelated-tampered.json")"

# A symlinked settings.json: the target is updated, the link stays a link.
reset
mkdir -p "${H}/dotfiles"
cp "${FX}/unrelated.json" "${H}/dotfiles/settings.json"
ln -s ../dotfiles/settings.json "$SETTINGS"
rc="$(install_)"
check "symlink: install exits 0" "0" "$rc"
if [[ -L "$SETTINGS" && "$(readlink "$SETTINGS")" == "../dotfiles/settings.json" ]]; then ok "symlink: settings.json is still the same link"; else bad "symlink: settings.json is still the same link"; fi
check "symlink: the target carries the hook" "1|${HOOK_CMD}" "$(calico_hooks "${H}/dotfiles/settings.json")"
check "symlink: the target is contract-equal to the input" "equal" "$(contract "${FX}/unrelated.json" "${H}/dotfiles/settings.json")"
if cmp -s "${FX}/unrelated.json" "${H}/dotfiles/settings.json.calico-bak"; then ok "symlink: the backup sits beside the target"; else bad "symlink: the backup sits beside the target"; fi

# Refusals: the file is left byte-for-byte, and nothing after the merge runs.
refuse_case() { # <label> <content> [message]
  reset
  printf '%s' "$2" > "$SETTINGS"
  cp "$SETTINGS" "${SANDBOX}/refuse-in.json"
  rc="$(install_)"
  check "$1: install fails" "1" "$rc"
  if cmp -s "$SETTINGS" "${SANDBOX}/refuse-in.json"; then ok "$1: bytes unchanged"; else bad "$1: bytes unchanged"; fi
  if [[ ! -e "${SETTINGS}.calico-bak" ]]; then ok "$1: no backup written"; else bad "$1: no backup written"; fi
  check "$1: no temp file left" "0" "$(leftover_temps "${H}/.claude")"
  if ! grep -q bootstrap "$LC_LOG"; then ok "$1: the timer is not loaded"; else bad "$1: the timer is not loaded"; fi
  contains "$1: the uninstall command is printed for what was already installed" "bash -s -- --uninstall" "$OUT"
  if [[ -n "${3:-}" ]]; then contains "$1: says why" "$3" "$OUT"; fi
}
refuse_case "invalid JSON" '{"hooks": {"SessionStart": [}' "cannot parse"
refuse_case "duplicate key" '{"theme": "dark", "theme": "light"}' "duplicate key 'theme'"
refuse_case "NaN" '{"x": NaN}' "non-standard JSON value NaN"
refuse_case "top-level array" '[1, 2]' "does not hold a JSON object"
refuse_case "hooks is not an object" '{"hooks": []}' '"hooks" is not an object'
refuse_case "SessionStart is not an array" '{"hooks": {"SessionStart": {}}}' '"hooks.SessionStart" is not an array'
refuse_case "invalid UTF-8" "$(printf '{"x": "\xff"}')" "settings.json update failed"

# Another writer changes the file between the read and the rename.
reset
cp "${FX}/unrelated.json" "$SETTINGS"
rc="$(install_ PYTHONPATH="$CONCURRENT" FAKE_CONCURRENT_WRITE="$SETTINGS")"
check "concurrent change: install fails" "1" "$rc"
contains "concurrent change: says so" "changed while it was being updated" "$OUT"
{ cat "${FX}/unrelated.json"; printf ' '; } > "${SANDBOX}/concurrent-expected.json"
if cmp -s "${SANDBOX}/concurrent-expected.json" "$SETTINGS"; then ok "concurrent change: the other writer's bytes survive"; else bad "concurrent change: the other writer's bytes survive"; fi
check "concurrent change: no temp file left" "0" "$(leftover_temps "${H}/.claude")"

# Backup: replaced each run, 0600 even when the old one was world-readable.
reset
cp "${FX}/no-hooks.json" "$SETTINGS"
printf 'OLD BACKUP\n' > "${SETTINGS}.calico-bak"
chmod 0644 "${SETTINGS}.calico-bak"
rc="$(install_)"
check "backup: install exits 0" "0" "$rc"
if cmp -s "${FX}/no-hooks.json" "${SETTINGS}.calico-bak"; then ok "backup: the old backup is replaced by this run's input"; else bad "backup: the old backup is replaced by this run's input"; fi
check "backup: 0600 regardless of the old file's mode" "600" "$(mode_of "${SETTINGS}.calico-bak")"
check "backup: exactly one backup file" "1" "$(ls -a "${H}/.claude" | grep -c 'calico-bak')"
# A re-run that changes nothing writes nothing, so the backup still holds the
# file as it was before Calico touched it.
rc="$(install_)"
if cmp -s "${FX}/no-hooks.json" "${SETTINGS}.calico-bak"; then ok "backup: a no-op re-run keeps the pre-install backup"; else bad "backup: a no-op re-run keeps the pre-install backup"; fi

# --- 5. launchd failures ---------------------------------------------------------------
reset
printf '/elsewhere.plist\n' > "${LC_DIR}/loaded"
rc="$(install_ FAKE_LC_BOOTOUT_FAIL=1)"
check "bootout failing on a loaded job fails the install" "1" "$rc"
contains "bootout failure: named" "bootout gui/501/${TEST_LABEL} failed" "$OUT"
if ! grep -q bootstrap "$LC_LOG"; then ok "bootout failure: no bootstrap attempted"; else bad "bootout failure: no bootstrap attempted"; fi

reset
rc="$(install_ FAKE_LC_BOOTSTRAP_FAIL=1)"
check "bootstrap failing fails the install" "1" "$rc"
contains "bootstrap failure: exit status reported" "failed (exit 5)" "$OUT"

# --- 6. the updater fails --------------------------------------------------------------
reset
cp "${FX}/no-hooks.json" "$SETTINGS"
rc="$(install_ FAKE_UPDATER_RC=3)"
check "updater failure fails the install" "1" "$rc"
if cmp -s "${FX}/no-hooks.json" "$SETTINGS"; then ok "updater failure: settings.json untouched"; else bad "updater failure: settings.json untouched"; fi
check "updater failure: launchctl never called" "0" "$(wc -l < "$LC_LOG" | tr -d ' ')"
contains "updater failure: the uninstall command is printed" "bash -s -- --uninstall" "$OUT"

# A re-run whose updater fails (a failed attestation, say) while the launcher
# from the earlier install is still there: the failure must still stop it.
reset
rc="$(install_)"
cp "${FX}/no-hooks.json" "$SETTINGS"
: > "$LC_LOG"
rc="$(install_ FAKE_UPDATER_RC=3)"
check "updater failure with an existing launcher fails the install" "1" "$rc"
contains "updater failure with an existing launcher: says so" "The updater could not install calico-claude" "$OUT"
if cmp -s "${FX}/no-hooks.json" "$SETTINGS"; then ok "updater failure with an existing launcher: settings.json untouched"; else bad "updater failure with an existing launcher: settings.json untouched"; fi
check "updater failure with an existing launcher: launchctl never called" "0" "$(wc -l < "$LC_LOG" | tr -d ' ')"

# The updater exits 0 without installing (another run held its lock).
reset
rc="$(install_ FAKE_UPDATER_NOLINK=1)"
check "no launcher after the updater fails the install" "1" "$rc"
contains "no launcher: says so" "calico-claude is missing" "$OUT"
if [[ ! -e "$SETTINGS" ]]; then ok "no launcher: settings.json not written"; else bad "no launcher: settings.json not written"; fi

# --- 7. repo selection and credentials --------------------------------------------------
reset
rc="$(install_ CALICO_REPO=fork-owner/calico-fork)"
check "CALICO_REPO: install exits 0" "0" "$rc"
check "CALICO_REPO: config" "repo=fork-owner/calico-fork" "$(cat "${H}/.claude/calico/config")"
check "CALICO_REPO: every request goes to the fork" "3" "$(grep -c 'fork-owner/calico-fork' "$URLS")"
check "CALICO_REPO: the updater installs from the fork" "--force|repo=fork-owner/calico-fork|link=unset" "$(cat "$UPD_LOG")"

reset
rc="$(install_ CALICO_REPO=loses/this PATCH_CLAUDE_REPO=wins/this)"
check "PATCH_CLAUDE_REPO wins over CALICO_REPO" "repo=wins/this" "$(cat "${H}/.claude/calico/config")"

reset
rc="$(install_ CALICO_SOURCE_REF=some-branch)"
check "CALICO_SOURCE_REF is resolved, and files still come by SHA" \
  "https://api.github.com/repos/Nanako0129/calico-claude/commits/some-branch|2" \
  "$(sed -n 1p "$URLS")|$(grep -c "/${FAKE_SHA}/" "$URLS")"

reset
rc="$(install_ FAKE_SHA=main)"
check "an API answer that is not a SHA fails the install" "1" "$rc"
if [[ ! -e "${H}/.claude/calico" ]]; then ok "not a SHA: nothing written"; else bad "not a SHA: nothing written"; fi

reset; install_ GITHUB_TOKEN=t-github GH_TOKEN=t-gh FAKE_GH_TOKEN=t-cli >/dev/null
check "GITHUB_TOKEN first, on stdin, on the API call only" "Authorization: Bearer t-github" "$(cat "$AUTH")"
reset; install_ GH_TOKEN=t-gh FAKE_GH_TOKEN=t-cli >/dev/null
check "then GH_TOKEN" "Authorization: Bearer t-gh" "$(cat "$AUTH")"
reset; install_ FAKE_GH_TOKEN=t-cli >/dev/null
check "then gh auth token" "Authorization: Bearer t-cli" "$(cat "$AUTH")"
reset; install_ >/dev/null
check "no credential: no header" "" "$(cat "$AUTH")"

# --- 8. the official claude -----------------------------------------------------------------
printf '#!/bin/sh\necho "2.1.281 (Claude Code) (patched)"\n' > "${CLAUDE_BIN}/claude"
chmod +x "${CLAUDE_BIN}/claude"
cp "${CLAUDE_BIN}/claude" "${SANDBOX}/claude-before"
reset
rc="$(EXTRA_PATH="${CLAUDE_BIN}:" install_)"
check "patched official claude: install exits 0" "0" "$rc"
contains "patched official claude: says how to restore" "curl -fsSL https://claude.ai/install.sh | bash" "$OUT"
if cmp -s "${CLAUDE_BIN}/claude" "${SANDBOX}/claude-before"; then ok "patched official claude: left byte-for-byte"; else bad "patched official claude: left byte-for-byte"; fi
printf '#!/bin/sh\necho "2.1.281 (Claude Code)"\n' > "${CLAUDE_BIN}/claude"
reset
rc="$(EXTRA_PATH="${CLAUDE_BIN}:" install_)"
if ! grep -q "claude.ai/install.sh" "$OUT"; then ok "official claude: no restore notice"; else bad "official claude: no restore notice"; fi

# --- 9. Linux ------------------------------------------------------------------------------
reset
cp "${FX}/no-hooks.json" "$SETTINGS"
rc="$(install_ FAKE_UNAME_S=Linux)"
check "Linux: install exits 0" "0" "$rc"
check "Linux: one API request and one raw file (no plist)" "2" "$(wc -l < "$URLS" | tr -d ' ')"
check "Linux: launchctl never called" "0" "$(wc -l < "$LC_LOG" | tr -d ' ')"
if [[ ! -e "${H}/Library" ]]; then ok "Linux: no LaunchAgents or Logs written"; else bad "Linux: no LaunchAgents or Logs written"; fi
check "Linux: the hook is wired" "1|${HOOK_CMD}" "$(calico_hooks "$SETTINGS")"
contains "Linux: says there is no timer" "No timer on Linux" "$OUT"

# --- 10. uninstall -------------------------------------------------------------------------
uninstall_case() { # <fixture-or-missing> <label>
  reset
  [[ -e "$1" ]] && cp "$1" "$SETTINGS"
  # Neighbours that are not Calico's.
  mkdir -p "${H}/.local/bin" "${H}/.local/share/other" "${H}/Library/LaunchAgents" "${H}/.claude/projects"
  printf 'x\n' > "${H}/.local/bin/other"; printf 'x\n' > "${H}/.local/share/other/f"
  printf 'x\n' > "${H}/Library/LaunchAgents/other.plist"; printf 'x\n' > "${H}/.claude/projects/f"
  rc="$(install_)"
  check "$2: install exits 0" "0" "$rc"
  : > "$LC_LOG"
  rc="$(uninstall_)"
  check "$2: uninstall exits 0" "0" "$rc"
  check "$2: contract-equal to the pre-install input" "equal" "$(contract "$1" "$SETTINGS")"
  local gone=1 p
  for p in "${H}/.local/bin/calico-claude" "${H}/.local/share/calico-claude" "${H}/.claude/calico" \
           "${H}/Library/LaunchAgents/${TEST_LABEL}.plist" "${H}/Library/Logs/calico-auto-update.log"; do
    [[ -e "$p" || -L "$p" ]] && { gone=0; bad "$2: $p removed"; }
  done
  (( gone )) && ok "$2: launcher, builds, state, plist and timer log removed"
  local kept=1
  for p in "${H}/.local/bin/other" "${H}/.local/share/other/f" "${H}/Library/LaunchAgents/other.plist" "${H}/.claude/projects/f"; do
    [[ -f "$p" ]] || { kept=0; bad "$2: $p kept"; }
  done
  (( kept )) && ok "$2: unrelated files kept"
  check "$2: the job was booted out" "bootout gui/501/${TEST_LABEL}" "$(sed -n 1p "$LC_LOG")"
  if [[ ! -e "${LC_DIR}/loaded" ]]; then ok "$2: no job left loaded"; else bad "$2: no job left loaded"; fi
  rc="$(uninstall_)"
  check "$2: a second uninstall exits 0" "0" "$rc"
}
uninstall_case "${FX}/does-not-exist.json" "uninstall (no settings.json before)"
if [[ -e "$SETTINGS" ]]; then check "uninstall (no settings.json before): what remains is {}" "{}" "$(tr -d ' \n' < "$SETTINGS")"; fi
uninstall_case "${FX}/empty.json" "uninstall (empty settings.json)"
uninstall_case "${FX}/no-hooks.json" "uninstall (no hooks)"
check "uninstall (no hooks): the hooks key it added is gone" "model permissions env" \
  "$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))))' "$SETTINGS")"
uninstall_case "${FX}/unrelated.json" "uninstall (unrelated hooks)"
uninstall_case "${FX}/stale.json" "uninstall (stale entries)"

# Unrelated content is compared by the contract, and an earlier hand-written
# Calico hook is removed with ours.
check "uninstall (stale entries): no Calico hook remains" "0|" "$(calico_hooks "$SETTINGS")"

# A launcher that is not a symlink was not made by the updater: left alone.
reset
mkdir -p "${H}/.local/bin"
rc="$(install_)"
rm -f "${H}/.local/bin/calico-claude"; printf 'MINE\n' > "${H}/.local/bin/calico-claude"
rc="$(uninstall_)"
check "uninstall: a non-symlink launcher is kept" "MINE" "$(cat "${H}/.local/bin/calico-claude")"

# settings.json that does not parse: uninstall refuses before removing anything.
reset
rc="$(install_)"
printf '{broken' > "$SETTINGS"
: > "$LC_LOG"
rc="$(uninstall_)"
check "uninstall with unparsable settings.json fails" "1" "$rc"
if [[ -L "${H}/.local/bin/calico-claude" && -e "${H}/.claude/calico/update.sh" && -e "${LC_DIR}/loaded" ]]; then
  ok "uninstall with unparsable settings.json removes nothing"
else bad "uninstall with unparsable settings.json removes nothing"; fi
check "uninstall with unparsable settings.json leaves its bytes" "{broken" "$(cat "$SETTINGS")"

# Uninstall with nothing installed and no settings file: exits 0, creates nothing.
reset
rc="$(uninstall_)"
check "uninstall on a clean HOME exits 0" "0" "$rc"
if [[ ! -e "$SETTINGS" ]]; then ok "uninstall on a clean HOME creates no settings.json"; else bad "uninstall on a clean HOME creates no settings.json"; fi

# An unparsable file that has no Calico hook is still never rewritten by uninstall
# (the other direction: a valid file without our hook keeps its exact bytes).
reset
cp "${FX}/reindented.json" "$SETTINGS"
rc="$(uninstall_)"
if cmp -s "${FX}/reindented.json" "$SETTINGS"; then ok "uninstall without a Calico hook leaves the file's bytes"; else bad "uninstall without a Calico hook leaves the file's bytes"; fi

# Linux uninstall never calls launchctl.
reset
rc="$(install_ FAKE_UNAME_S=Linux)"
: > "$LC_LOG"
rc="$(uninstall_ FAKE_UNAME_S=Linux)"
check "Linux uninstall exits 0" "0" "$rc"
check "Linux uninstall: launchctl never called" "0" "$(wc -l < "$LC_LOG" | tr -d ' ')"
if [[ ! -e "${H}/.claude/calico" && ! -L "${H}/.local/bin/calico-claude" ]]; then ok "Linux uninstall: state and launcher removed"; else bad "Linux uninstall: state and launcher removed"; fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
