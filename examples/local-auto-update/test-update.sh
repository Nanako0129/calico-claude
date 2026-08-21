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

# --- curl stub ----------------------------------------------------------------
# Installed before any case that can reach the network. `--hook` spawns a
# detached `--run`, and a nonexistent CALICO_REPO does not prevent that run from
# contacting api.github.com — it only guarantees a 404. Without the stub on PATH
# the suite would break its own offline guarantee and could leave a detached
# curl behind after the sandbox is removed.
STUB_BIN="${SANDBOX}/stub-bin"
mkdir -p "$STUB_BIN"
cat > "${STUB_BIN}/curl" <<'STUB'
#!/bin/sh
# Minimal curl stand-in. Serves the release list, the asset, or its checksums
# depending on the URL, so a full --run can be exercised without a network.
out=""
url=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  case "$arg" in http*) url="$arg" ;; esac
  prev="$arg"
done
[ -n "$out" ] || exit 1
case "$url" in
  *checksums.txt) [ -n "$FAKE_CHECKSUMS" ] && cat "$FAKE_CHECKSUMS" > "$out" || exit 1 ;;
  *api.github.com*) cat "$FAKE_RELEASES" > "$out" ;;
  *) [ -n "$FAKE_ASSET" ] && cat "$FAKE_ASSET" > "$out" || exit 1 ;;
esac
STUB
chmod +x "${STUB_BIN}/curl"
cat > "${STUB_BIN}/gh" <<'STUB'
#!/bin/sh
# Unauthenticated gh: exercises the documented "skip attestation with a warning"
# path rather than failing a stub asset that carries no real provenance.
[ "$1" = "auth" ] && exit 1
exit 1
STUB
chmod +x "${STUB_BIN}/gh"

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
export PATH="${STUB_BIN}:${PATH}"
export FAKE_RELEASES="${SANDBOX}/releases.json"
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
# A live owner means real contention; a dead one means the previous run was
# killed before its EXIT trap ran, and the lock must be reclaimed rather than
# obeyed forever.
#
# These cases get their own state directory. The hook cases above necessarily
# spawn detached `--run` children, and one still finishing could otherwise
# acquire or release a lock belonging to an assertion here — the assertions
# would then pass or fail on timing rather than on behaviour.
LOCK_STATE="${SANDBOX}/lock-state"
mkdir -p "$LOCK_STATE"
run_locked() { CALICO_PLATFORM=linux-x64 CALICO_STATE_DIR="$LOCK_STATE" bash "$UPDATE_SH" --run 2>&1; }

mkdir -p "${LOCK_STATE}/.lock"
printf '%s\n' "$$" > "${LOCK_STATE}/.lock/pid"
out="$(run_locked)"
rc=$?
check "run exits 0 when a live owner holds the lock" "0" "$rc"
if [[ "$out" == *"already in progress (pid $$)"* ]]; then ok "run reports the live lock owner"; else bad "run reports the live lock owner (got: ${out})"; fi
if [[ -d "${LOCK_STATE}/.lock" ]]; then ok "a live owner's lock survives"; else bad "a live owner's lock survives"; fi
rm -rf "${LOCK_STATE}/.lock"

# Find a pid that is definitely not running, so the lock reads as abandoned.
dead_pid=999999
while kill -0 "$dead_pid" 2>/dev/null; do dead_pid=$((dead_pid - 1)); done
mkdir -p "${LOCK_STATE}/.lock"
printf '%s\n' "$dead_pid" > "${LOCK_STATE}/.lock/pid"
out="$(run_locked)"
if [[ "$out" == *"Reclaiming stale lock"* ]]; then ok "a stale lock is reclaimed instead of obeyed"; else bad "a stale lock is reclaimed instead of obeyed (got: ${out})"; fi
if [[ ! -d "${LOCK_STATE}/.lock" ]]; then ok "the reclaimed lock is released on exit"; else bad "the reclaimed lock is released on exit"; fi
rm -rf "${LOCK_STATE}/.lock"

# A pid-less lock is ambiguous: a run killed between mkdir and the write, or one
# that is about to write it. Deleting the second would let two installers run at
# once, so a fresh one counts as contention and only an aged one is reclaimed.
mkdir -p "${LOCK_STATE}/.lock"
out="$(run_locked)"
if [[ "$out" == *"starting up"* ]]; then ok "a freshly pid-less lock is treated as contention"; else bad "a freshly pid-less lock is treated as contention (got: ${out})"; fi
if [[ -d "${LOCK_STATE}/.lock" ]]; then ok "a freshly pid-less lock is not deleted"; else bad "a freshly pid-less lock is not deleted"; fi
rm -rf "${LOCK_STATE}/.lock"

mkdir -p "${LOCK_STATE}/.lock"
touch -t 202601010000 "${LOCK_STATE}/.lock"
out="$(run_locked)"
if [[ "$out" == *"Reclaiming stale lock"* ]]; then ok "an aged pid-less lock is reclaimed"; else bad "an aged pid-less lock is reclaimed (got: ${out})"; fi
rm -rf "${LOCK_STATE}/.lock"

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
# The curl stub is installed near the top of this file, because the hook cases
# below spawn a detached `--run` that would otherwise reach the network.

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

# --- 8. end-to-end --run ------------------------------------------------------
# Drives the real install path with stubbed curl and gh. These cover the parts
# that unit-level cases cannot: what happens to files already on disk when the
# incoming artifact turns out to be wrong.

E2E="${SANDBOX}/e2e"
e2e_reset() { # <asset-body-file>
  rm -rf "$E2E"; mkdir -p "$E2E/versions" "$E2E/bin" "$E2E/state"
  cp "$1" "$E2E/asset"; chmod +x "$E2E/asset"
  ( cd "$E2E" && { shasum -a 256 asset 2>/dev/null || sha256sum asset; } \
      | sed 's/asset$/claude.native.patched/' > "$E2E/checksums.txt" )
  cat > "$E2E/releases.json" <<JSON
[{"tag_name":"v9.9.9-linux-x64","assets":[
  {"name":"claude.native.patched","browser_download_url":"https://example.invalid/asset"},
  {"name":"checksums.txt","browser_download_url":"https://example.invalid/checksums.txt"}]}]
JSON
}
e2e_run() { # <mode>
  env PATH="${STUB_BIN}:${PATH}" \
      FAKE_RELEASES="$E2E/releases.json" FAKE_ASSET="$E2E/asset" FAKE_CHECKSUMS="$E2E/checksums.txt" \
      CALICO_PLATFORM=linux-x64 CALICO_REPO="calico-test/stubbed" \
      CALICO_VERSIONS_DIR="$E2E/versions" CALICO_BIN_LINK="$E2E/bin/calico-claude" \
      CALICO_STATE_DIR="$E2E/state" E2E_COUNTER="$E2E/calls" \
      bash "$UPDATE_SH" "$1" 2>&1
}

printf '#!/bin/sh\necho "9.9.9 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-good"
printf '#!/bin/sh\necho "0.0.0 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-wrongver"
printf '#!/bin/sh\necho "9.9.99 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-superstring"
# Passes the pre-install check, then reports a different version once installed.
printf '#!/bin/sh\nn=$(cat "$E2E_COUNTER" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$E2E_COUNTER"\nif [ "$n" -le 1 ]; then echo "9.9.9 (Claude Code)"; echo "(patched)"; else echo "0.0.0 (Claude Code)"; echo "(patched)"; fi\n' > "${SANDBOX}/asset-flips"

e2e_reset "${SANDBOX}/asset-good"
out="$(e2e_run --run)"
check "e2e: a good artifact installs" "0" "$?"
if [[ -L "$E2E/bin/calico-claude" && "$(readlink "$E2E/bin/calico-claude")" == "$E2E/versions/9.9.9" ]]; then
  ok "e2e: symlink points at the installed version"
else bad "e2e: symlink points at the installed version"; fi

# The reinstall paths (--force, and the self-heal for an unpatched same-version
# binary) write to a destination that already exists. If the incoming artifact
# is only checked after that write, the rollback target is already destroyed.
e2e_reset "${SANDBOX}/asset-wrongver"
printf 'KNOWN GOOD\n' > "$E2E/versions/9.9.9"
ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
out="$(e2e_run --force)"
rc=$?
check "e2e: a bad artifact fails --force" "1" "$rc"
check "e2e: the existing same-version build is left intact" "KNOWN GOOD" "$(cat "$E2E/versions/9.9.9")"
check "e2e: the symlink still points at the surviving build" "$E2E/versions/9.9.9" "$(readlink "$E2E/bin/calico-claude")"

# "2.1.24" is a substring of "2.1.240"; only an exact token comparison rejects it.
e2e_reset "${SANDBOX}/asset-superstring"
out="$(e2e_run --run)"
check "e2e: a version that merely contains the expected one is rejected" "1" "$?"
if [[ -e "$E2E/versions/9.9.9" ]]; then bad "e2e: superstring version must not be installed"; else ok "e2e: superstring version must not be installed"; fi

# First install, nothing to roll back to: a link to a binary that just failed
# its check is worse than no link at all.
e2e_reset "${SANDBOX}/asset-flips"
out="$(e2e_run --run)"
check "e2e: a binary failing post-verify fails the run" "1" "$?"
if [[ -e "$E2E/bin/calico-claude" || -L "$E2E/bin/calico-claude" ]]; then
  bad "e2e: the symlink is removed when there is no rollback target"
else ok "e2e: the symlink is removed when there is no rollback target"; fi

# --- 8b. same-version rebuilds ------------------------------------------------
# A corrected build is republished under a numeric suffix while the version
# stays the same. Comparing versions alone reports "up to date", so unattended
# users would never receive it.

e2e_rebuild_releases() { # <highest-tag>
  cat > "$E2E/releases.json" <<JSON
[{"tag_name":"v9.9.9-linux-x64","assets":[
  {"name":"claude.native.patched","browser_download_url":"https://example.invalid/asset"},
  {"name":"checksums.txt","browser_download_url":"https://example.invalid/checksums.txt"}]},
 {"tag_name":"$1","assets":[
  {"name":"claude.native.patched","browser_download_url":"https://example.invalid/asset"},
  {"name":"checksums.txt","browser_download_url":"https://example.invalid/checksums.txt"}]}]
JSON
}
e2e_installed() { # <tag>
  cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.9"; chmod +x "$E2E/versions/9.9.9"
  ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
  printf '%s\n' "$1" > "$E2E/state/installed-tag"
}

e2e_reset "${SANDBOX}/asset-good"; e2e_rebuild_releases "v9.9.9-linux-x64-2"
e2e_installed "v9.9.9-linux-x64"
out="$(e2e_run --run)"
if [[ "$out" == *"newer rebuild"* ]]; then ok "a newer rebuild of the installed version is picked up"; else bad "a newer rebuild of the installed version is picked up (got: ${out})"; fi
check "the rebuild tag is recorded after install" "v9.9.9-linux-x64-2" "$(cat "$E2E/state/installed-tag")"

e2e_reset "${SANDBOX}/asset-good"; e2e_rebuild_releases "v9.9.9-linux-x64-2"
e2e_installed "v9.9.9-linux-x64-2"
out="$(e2e_run --run)"
if [[ "$out" == *"up to date"* ]]; then ok "an already-installed rebuild is not reinstalled"; else bad "an already-installed rebuild is not reinstalled (got: ${out})"; fi

# Installs predating this feature have no recorded tag. They must not be
# reinstalled just because the file is missing.
e2e_reset "${SANDBOX}/asset-good"
e2e_installed "v9.9.9-linux-x64"; rm -f "$E2E/state/installed-tag"
out="$(e2e_run --run)"
if [[ "$out" == *"up to date"* ]]; then ok "a missing tag record does not force a reinstall"; else bad "a missing tag record does not force a reinstall (got: ${out})"; fi

# --- 8c. same-version install must survive a late failure ---------------------
# The pre-install check runs the artifact from the temp directory. An artifact
# that passes there and fails from its installed location would, without a
# preserved copy, leave `dest` holding the failed replacement — and `old_target`
# names that same path, so rolling the symlink back would restore nothing.

e2e_reset "${SANDBOX}/asset-flips"; e2e_rebuild_releases "v9.9.9-linux-x64-2"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.9"; chmod +x "$E2E/versions/9.9.9"
ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
printf 'v9.9.9-linux-x64\n' > "$E2E/state/installed-tag"
out="$(e2e_run --run)"
rc=$?
check "e2e: a late failure on a same-version install fails the run" "1" "$rc"
# Compared by content, not by running it: the flipping fixture keys its output
# off a counter file, so executing it here would reset that and report the good
# version either way — the assertion would pass whether or not the restore ran.
if cmp -s "$E2E/versions/9.9.9" "${SANDBOX}/asset-good"; then
  ok "e2e: the replaced same-version build is restored"
else bad "e2e: the replaced same-version build is restored"; fi
check "e2e: the symlink still resolves to the restored build" "$E2E/versions/9.9.9" "$(readlink "$E2E/bin/calico-claude")"
if [[ -z "$(find "$E2E/versions" -name '*.preserved.*' 2>/dev/null)" ]]; then
  ok "e2e: no preserved copy is left behind"
else bad "e2e: no preserved copy is left behind"; fi

# --- 8d. --check must agree with --run ----------------------------------------
# A read-only check that reports "up to date" while --run would immediately
# install tells the user the opposite of what is about to happen.

e2e_reset "${SANDBOX}/asset-good"; e2e_rebuild_releases "v9.9.9-linux-x64-2"
e2e_installed "v9.9.9-linux-x64"
out="$(e2e_run --check)"
if [[ "$out" == *"rebuild available (v9.9.9-linux-x64-2)"* ]]; then ok "--check reports an available rebuild"; else bad "--check reports an available rebuild (got: ${out})"; fi

e2e_reset "${SANDBOX}/asset-good"; e2e_rebuild_releases "v9.9.9-linux-x64-2"
e2e_installed "v9.9.9-linux-x64-2"
out="$(e2e_run --check)"
if [[ "$out" == *"up to date"* ]]; then ok "--check reports up to date once the rebuild is installed"; else bad "--check reports up to date once the rebuild is installed (got: ${out})"; fi

# The official updater replacing the patched binary keeps the version identical.
e2e_reset "${SANDBOX}/asset-good"
printf '#!/bin/sh\necho "9.9.9 (Claude Code)"\n' > "$E2E/versions/9.9.9"; chmod +x "$E2E/versions/9.9.9"
ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
printf 'v9.9.9-linux-x64\n' > "$E2E/state/installed-tag"
out="$(e2e_run --check)"
if [[ "$out" == *"reinstall needed"* ]]; then ok "--check reports an unpatched binary as needing reinstall"; else bad "--check reports an unpatched binary as needing reinstall (got: ${out})"; fi

# --- 9. usage -----------------------------------------------------------------
bash "$UPDATE_SH" >/dev/null 2>&1
check "no mode exits 2" "2" "$?"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
