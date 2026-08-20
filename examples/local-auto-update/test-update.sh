#!/usr/bin/env bash
#
# Offline self-check for update.sh. Exercises the pure-local logic (platform
# detection, checksum gate, pruning, hook throttling, log rotation) in a
# sandbox; never touches the real install paths and never downloads anything.
#
# Usage: bash test-update.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_SH="${SCRIPT_DIR}/update.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}

export CALICO_STATE_DIR="${SANDBOX}/state"
export CALICO_VERSIONS_DIR="${SANDBOX}/versions"
export CALICO_BIN_LINK="${SANDBOX}/bin/calico-claude"
mkdir -p "$CALICO_STATE_DIR" "$CALICO_VERSIONS_DIR" "${SANDBOX}/bin"

# --- 1. platform detection ----------------------------------------------------
for pair in "linux-x64:claude.native.patched:0" \
            "linux-arm64:claude.native.patched:0" \
            "macos-arm64:claude.native.macos.patched:1" \
            "win32-x64:claude.native.windows.patched.exe:0" \
            "win32-arm64:claude.native.windows.patched.exe:0"; do
  plat="${pair%%:*}"; rest="${pair#*:}"; want_asset="${rest%%:*}"; want_macos="${rest##*:}"
  out="$(CALICO_PLATFORM="$plat" bash -c '
    source_stub="$1"; source "$source_stub"; detect_platform; printf "%s|%s" "$ASSET" "$IS_MACOS"
  ' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH"))"
  check "detect_platform $plat" "${want_asset}|${want_macos}" "$out"
done

out="$(CALICO_PLATFORM="bogus-plat" bash -c '
  source_stub="$1"; source "$source_stub"; detect_platform 2>/dev/null; echo "SHOULD NOT REACH"
' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH") 2>&1)"
if [[ "$out" == *"SHOULD NOT REACH"* ]]; then bad "detect_platform rejects unknown suffix"; else ok "detect_platform rejects unknown suffix"; fi

# --- 2. checksum gate ---------------------------------------------------------
run_checksum_case() { # <dir> ; echoes exit status
  # verify_checksum calls fail() -> exit 1, so the status must be read from the
  # subshell itself rather than from a trailing echo inside it.
  CALICO_PLATFORM=linux-x64 bash -c '
    stub="$1"; dir="$2"; source "$stub"; detect_platform; verify_checksum "$dir"
  ' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH") "$1" >/dev/null 2>&1
  echo $?
}

good="${SANDBOX}/cs-good"; mkdir -p "$good"
printf 'payload\n' > "${good}/claude.native.patched"
( cd "$good" && { shasum -a 256 claude.native.patched 2>/dev/null || sha256sum claude.native.patched; } > checksums.txt )
check "verify_checksum accepts a matching digest" "0" "$(run_checksum_case "$good")"

tampered="${SANDBOX}/cs-tampered"; mkdir -p "$tampered"
cp "${good}/checksums.txt" "$tampered/"
printf 'TAMPERED\n' > "${tampered}/claude.native.patched"
check "verify_checksum rejects a tampered asset" "1" "$(run_checksum_case "$tampered")"

missing="${SANDBOX}/cs-missing"; mkdir -p "$missing"
printf 'payload\n' > "${missing}/claude.native.patched"
printf 'deadbeef  some-other-file\n' > "${missing}/checksums.txt"
check "verify_checksum rejects a checksums.txt without our asset" "1" "$(run_checksum_case "$missing")"

# A decoy whose name differs from the asset only where the asset has a dot:
# an unescaped `.` in the grep pattern matches it, so the gate would verify the
# decoy and let the real (unlisted, hostile) asset through.
decoy="${SANDBOX}/cs-decoy"; mkdir -p "$decoy"
printf 'decoy\n' > "${decoy}/claudeanativeapatched"
( cd "$decoy" && { shasum -a 256 claudeanativeapatched 2>/dev/null || sha256sum claudeanativeapatched; } > checksums.txt )
printf 'EVIL\n' > "${decoy}/claude.native.patched"
check "verify_checksum rejects a decoy entry matching only via an unescaped dot" "1" "$(run_checksum_case "$decoy")"

empty="${SANDBOX}/cs-empty"; mkdir -p "$empty"
printf 'payload\n' > "${empty}/claude.native.patched"
: > "${empty}/checksums.txt"
check "verify_checksum rejects an empty checksums.txt" "1" "$(run_checksum_case "$empty")"

# --- 3. pruning ---------------------------------------------------------------
seed_versions() { # <current-version> <version...>
  rm -rf "$CALICO_VERSIONS_DIR" "${SANDBOX}/bin"; mkdir -p "$CALICO_VERSIONS_DIR" "${SANDBOX}/bin"
  local current="$1"; shift
  local i=0
  for v in "$@"; do
    printf 'binary %s\n' "$v" > "${CALICO_VERSIONS_DIR}/${v}"
    # Oldest listed gets the oldest mtime so `ls -t` order is deterministic.
    touch -t "20260101$(printf '%02d' $((10 + i)))00" "${CALICO_VERSIONS_DIR}/${v}"
    i=$((i + 1))
  done
  [[ -n "$current" ]] && ln -sf "${CALICO_VERSIONS_DIR}/${current}" "$CALICO_BIN_LINK"
}

prune_with() { # <keep>
  CALICO_KEEP_VERSIONS="$1" bash -c '
    stub="$1"; source "$stub"; prune_old_versions >/dev/null 2>&1
  ' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH")
  ls "$CALICO_VERSIONS_DIR" | sort | tr '\n' ' ' | sed 's/ $//'
}

seed_versions "2.1.5" 2.1.1 2.1.2 2.1.3 2.1.4 2.1.5
check "prune keeps newest 3 including current" "2.1.3 2.1.4 2.1.5" "$(prune_with 3)"

seed_versions "2.1.5" 2.1.1 2.1.2 2.1.3 2.1.4 2.1.5
check "prune with KEEP=0 keeps everything" "2.1.1 2.1.2 2.1.3 2.1.4 2.1.5" "$(prune_with 0)"

# Rollback shape: the symlink points at an older build; it must survive.
seed_versions "2.1.1" 2.1.1 2.1.2 2.1.3 2.1.4 2.1.5
# Rollback: the newest 3 are kept AND the older current target survives on top.
check "prune never deletes the current symlink target" "2.1.1 2.1.3 2.1.4 2.1.5" "$(prune_with 3)"

seed_versions "" 2.1.1 2.1.2 2.1.3 2.1.4
rm -f "$CALICO_BIN_LINK"
check "prune tolerates a missing symlink" "2.1.2 2.1.3 2.1.4" "$(prune_with 3)"

# --- 4. hook throttling -------------------------------------------------------
# --hook must never block and must not spawn --run while inside the window.
# CALICO_REPO points at a nonexistent repo so any spawned --run fails fast
# without touching the network in a meaningful way.
export CALICO_REPO="calico-test/does-not-exist"
rm -f "${CALICO_STATE_DIR}/last-check" "${CALICO_STATE_DIR}/update.log"
printf '%s\n' "$(date +%s)" > "${CALICO_STATE_DIR}/last-check"
before="$(cat "${CALICO_STATE_DIR}/last-check")"
CALICO_THROTTLE_SECONDS=3600 bash "$UPDATE_SH" --hook < /dev/null >/dev/null 2>&1
rc=$?
check "hook inside throttle window exits 0" "0" "$rc"
check "hook inside throttle window leaves last-check untouched" "$before" "$(cat "${CALICO_STATE_DIR}/last-check")"
if [[ -s "${CALICO_STATE_DIR}/update.log" ]]; then bad "hook inside throttle window spawned a run"; else ok "hook inside throttle window spawned no run"; fi

printf '%s\n' "$(( $(date +%s) - 7200 ))" > "${CALICO_STATE_DIR}/last-check"
CALICO_THROTTLE_SECONDS=3600 bash "$UPDATE_SH" --hook < /dev/null >/dev/null 2>&1
rc=$?
check "hook past throttle window exits 0" "0" "$rc"
now_stamp="$(cat "${CALICO_STATE_DIR}/last-check")"
if (( $(date +%s) - now_stamp < 60 )); then ok "hook past throttle window refreshes last-check"; else bad "hook past throttle window refreshes last-check"; fi
sleep 3
if [[ -s "${CALICO_STATE_DIR}/update.log" ]]; then ok "hook past throttle window spawned a detached run"; else bad "hook past throttle window spawned a detached run"; fi

printf 'garbage\n' > "${CALICO_STATE_DIR}/last-check"
CALICO_THROTTLE_SECONDS=3600 bash "$UPDATE_SH" --hook < /dev/null >/dev/null 2>&1
check "hook tolerates a corrupt last-check" "0" "$?"

# --- 5. lock ------------------------------------------------------------------
mkdir -p "${CALICO_STATE_DIR}/.lock"
out="$(CALICO_PLATFORM=linux-x64 bash "$UPDATE_SH" --run 2>&1)"
rc=$?
check "run exits 0 when the lock is held" "0" "$rc"
if [[ "$out" == *"lock held"* ]]; then ok "run reports the held lock"; else bad "run reports the held lock"; fi
rmdir "${CALICO_STATE_DIR}/.lock"

# --- 6. log rotation ----------------------------------------------------------
LOG="${CALICO_STATE_DIR}/update.log"
python3 -c "
import sys
with open('$LOG', 'w') as f:
    for i in range(5000):
        f.write('line %d\n' % i)
"
bash -c '
  stub="$1"; source "$stub"; rotate_log
' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH")
lines="$(wc -l < "$LOG" | tr -d ' ')"
check "rotate_log trims an oversized log to 1000 lines" "1000" "$lines"
check "rotate_log keeps the newest lines" "line 4999" "$(tail -n 1 "$LOG")"

printf 'short\n' > "$LOG"
bash -c 'stub="$1"; source "$stub"; rotate_log' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH")
check "rotate_log leaves a small log alone" "1" "$(wc -l < "$LOG" | tr -d ' ')"

# --- 7. release selection under the oldest supported bash ---------------------
# Stock macOS ships /bin/bash 3.2, where "${empty_array[@]}" is an unbound
# variable under `set -u`. The suite otherwise runs under whatever `bash` is on
# PATH (often Homebrew 5.x), which hides that class of bug entirely.
STUB_BIN="${SANDBOX}/stub-bin"
mkdir -p "$STUB_BIN"
cat > "${STUB_BIN}/curl" <<'STUB'
#!/bin/sh
# Minimal curl stand-in: writes $FAKE_RELEASES to whatever -o names.
out=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"
done
[ -n "$out" ] || exit 1
cat "$FAKE_RELEASES" > "$out"
STUB
chmod +x "${STUB_BIN}/curl"

cat > "${SANDBOX}/releases.json" <<'JSON'
[
  {"tag_name": "v2.1.240-linux-x64", "assets": [
    {"name": "claude.native.patched", "browser_download_url": "https://example.invalid/a"},
    {"name": "checksums.txt", "browser_download_url": "https://example.invalid/c"}]},
  {"tag_name": "v2.1.240-linux-x64-2", "assets": [
    {"name": "claude.native.patched", "browser_download_url": "https://example.invalid/a2"},
    {"name": "checksums.txt", "browser_download_url": "https://example.invalid/c2"}]},
  {"tag_name": "v2.1.241-linux-x64", "assets": [
    {"name": "checksums.txt", "browser_download_url": "https://example.invalid/c3"}]},
  {"tag_name": "v2.1.243-linux-x64", "draft": true, "assets": [
    {"name": "claude.native.patched", "browser_download_url": "https://example.invalid/a4"},
    {"name": "checksums.txt", "browser_download_url": "https://example.invalid/c4"}]},
  {"tag_name": "v2.1.242-macos-arm64", "assets": [
    {"name": "claude.native.macos.patched", "browser_download_url": "https://example.invalid/a5"}]}
]
JSON

run_check() { # <bash-binary> ; runs --check with a stubbed curl and no token
  env -u GH_TOKEN -u GITHUB_TOKEN \
    PATH="${STUB_BIN}:${PATH}" \
    FAKE_RELEASES="${SANDBOX}/releases.json" \
    CALICO_PLATFORM=linux-x64 \
    CALICO_REPO="calico-test/stubbed" \
    "$1" "$UPDATE_SH" --check 2>&1
}

out="$(run_check bash)"
check "release selection prefers the rebuild suffix" "Latest release: 2.1.240 (tag v2.1.240-linux-x64-2)" "$(printf '%s\n' "$out" | grep '^Latest release:')"
if printf '%s' "$out" | grep -q "2.1.241"; then bad "release without our asset is skipped"; else ok "release without our asset is skipped"; fi
# The draft is the highest version in the fixture, so it wins unless filtered.
if printf '%s' "$out" | grep -q "2.1.243"; then bad "draft release is skipped"; else ok "draft release is skipped"; fi

if [[ -x /bin/bash ]]; then
  bash32_out="$(run_check /bin/bash)"
  if printf '%s' "$bash32_out" | grep -q "unbound variable"; then
    bad "--check runs under /bin/bash $(/bin/bash -c 'echo $BASH_VERSION') without an unbound variable"
  else
    ok "--check runs under /bin/bash $(/bin/bash -c 'echo $BASH_VERSION') without an unbound variable"
  fi
  check "--check under /bin/bash selects the same release" "Latest release: 2.1.240 (tag v2.1.240-linux-x64-2)" "$(printf '%s\n' "$bash32_out" | grep '^Latest release:')"
else
  printf 'skip /bin/bash not present\n'
fi

# --- 8. usage -----------------------------------------------------------------
bash "$UPDATE_SH" >/dev/null 2>&1
check "no mode exits 2" "2" "$?"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
