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
  *) # A competing updater finishing mid-download is simulated here rather than
     # by timing: the hook runs at the moment this run is fetching the asset.
     [ -n "$RACE_HOOK" ] && sh -c "$RACE_HOOK"
     [ -n "$FAKE_ASSET" ] && cat "$FAKE_ASSET" > "$out" || exit 1 ;;
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

# Pruning is now gated on holding the lock, which acquire_lock sets. These cases
# call the function directly, so they stand in for the lock holder explicitly.
prune_with() { # <keep>
  CALICO_KEEP_VERSIONS="$1" bash -c '
    stub="$1"; source "$stub"; LOCK_CREATED=1; prune_old_versions >/dev/null 2>&1
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

# A build young enough to belong to an overlapping run is left alone even when
# the retention count says it should go: that run may not have swapped its link
# yet, and deleting its destination would strand it.
#
# The young build must fall OUTSIDE the retention count for this to test
# anything. `ls -t` puts the newest first, so it has to sit behind a current
# target that is newer still — otherwise it survives on its retention slot and
# the age check is never consulted.
rm -rf "$CALICO_VERSIONS_DIR" "${SANDBOX}/bin"; mkdir -p "$CALICO_VERSIONS_DIR" "${SANDBOX}/bin"
printf 'old\n' > "${CALICO_VERSIONS_DIR}/2.1.1"
touch -t 202601011000 "${CALICO_VERSIONS_DIR}/2.1.1"
printf 'in flight\n' > "${CALICO_VERSIONS_DIR}/2.1.8"
printf 'current\n' > "${CALICO_VERSIONS_DIR}/2.1.9"
ln -sf "${CALICO_VERSIONS_DIR}/2.1.9" "$CALICO_BIN_LINK"
check "prune leaves a just-created build alone" "2.1.8 2.1.9" "$(prune_with 1)"

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
# The lock is an efficiency device: a young lock means another run is on it and
# this one skips the duplicate work; an aged lock is assumed abandoned and is
# ignored but NEVER removed — a run only ever deletes a lock it created itself.
#
# These cases get their own state directory. The hook cases above necessarily
# spawn detached `--run` children, and one still finishing could otherwise
# acquire or release a lock belonging to an assertion here — the assertions
# would then pass or fail on timing rather than on behaviour.
LOCK_STATE="${SANDBOX}/lock-state"
mkdir -p "$LOCK_STATE"
run_locked() { CALICO_PLATFORM=linux-x64 CALICO_STATE_DIR="$LOCK_STATE" bash "$UPDATE_SH" --run 2>&1; }

mkdir -p "${LOCK_STATE}/.lock"
out="$(run_locked)"
rc=$?
check "run exits 0 when a young lock exists (live owner)" "0" "$rc"
if [[ "$out" == *"already in progress"* ]]; then ok "run reports the contention"; else bad "run reports the contention (got: ${out})"; fi
if [[ -d "${LOCK_STATE}/.lock" ]]; then ok "a live owner's lock survives"; else bad "a live owner's lock survives"; fi
rm -rf "${LOCK_STATE}/.lock"

# An aged lock (SIGKILL, power loss, reboot: no EXIT trap ever ran) must not
# end updates forever — but it also must not be removed: it is not ours.
mkdir -p "${LOCK_STATE}/.lock"
touch -t 202601010000 "${LOCK_STATE}/.lock"
out="$(run_locked)"
if [[ "$out" == *"Ignoring lock"* ]]; then ok "an aged lock is ignored, not obeyed"; else bad "an aged lock is ignored, not obeyed (got: ${out})"; fi
if [[ -d "${LOCK_STATE}/.lock" ]]; then ok "a run that ignored a lock leaves it in place on exit"; else bad "a run that ignored a lock leaves it in place on exit"; fi
rm -rf "${LOCK_STATE}/.lock"

# --- 5b. lock age ---------------------------------------------------------------
# `stat` formatting differs between GNU and BSD, and the GNU spelling of the BSD
# flag SUCCEEDS with unrelated output rather than failing — so a `-f || -c`
# chain silently never falls through on Linux. This asserts the measured age,
# which fails on either platform if the wrong form is used.

age_of() { # <seconds-ago> ; echoes what lock_age_seconds reports
  local probe="${SANDBOX}/age-probe"
  rm -rf "$probe"; mkdir -p "$probe/.lock"
  python3 -c "import os,sys; t=float(sys.argv[2]); os.utime(sys.argv[1],(t,t))" \
    "$probe/.lock" "$(( $(date +%s) - $1 ))"
  CALICO_STATE_DIR="$probe" bash -c '
    stub="$1"; source "$stub"; path_age_seconds "$LOCK_DIR" || echo UNKNOWN
  ' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH")
}

reported="$(age_of 3600)"
if [[ "$reported" =~ ^[0-9]+$ ]] && (( reported > 3500 && reported < 3700 )); then
  ok "lock age is measured correctly on this platform ($reported s for a 1h-old lock)"
else
  bad "lock age is measured correctly on this platform (got: ${reported})"
fi

reported="$(age_of 5)"
if [[ "$reported" =~ ^[0-9]+$ ]] && (( reported < 60 )); then
  ok "a freshly created lock measures under the startup grace ($reported s)"
else
  bad "a freshly created lock measures under the startup grace (got: ${reported})"
fi

# --- 5c. install path allocation ----------------------------------------------
# The suffix must come from an exclusive create, not from the pid: pids are
# unique only among live processes, so a suffixed build that survives pruning
# can collide with a later run that is assigned the same pid.

# Both allocations must happen inside ONE process. Calling a helper twice from
# the harness would fork twice, giving each call a different pid — a pid-derived
# suffix would then look unique and the mutation would go undetected.
alloc() { # <base> [count] ; echoes <count> allocations from a single process
  bash -c 'stub="$1"; source "$stub"; n="${3:-1}"; while (( n-- > 0 )); do allocate_dest "$2"; done' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH") "$1" "${2:-1}"
}

alloc_dir="${SANDBOX}/alloc"; rm -rf "$alloc_dir"; mkdir -p "$alloc_dir"
base="${alloc_dir}/9.9.9"
check "an unused base path is returned as-is" "$base" "$(alloc "$base")"
rm -f "$base"

# Two overlapping runs can both find the base absent — an ignored lock permits
# exactly that — so the base must be reserved, not merely tested for.
fresh_pair="$(alloc "$base" 2)"
fresh_first="$(printf '%s\n' "$fresh_pair" | sed -n '1p')"
fresh_second="$(printf '%s\n' "$fresh_pair" | sed -n '2p')"
check "the first allocation of a free base takes the base itself" "$base" "$fresh_first"
if [[ "$fresh_second" != "$base" && "$fresh_second" != "$fresh_first" ]]; then
  ok "a second allocation cannot take the base another run just reserved"
else bad "a second allocation cannot take the base another run just reserved (got: $fresh_second)"; fi
rm -f "$base" "$fresh_second"

printf 'EXISTING
' > "$base"
pair="$(alloc "$base" 2)"
first="$(printf '%s\n' "$pair" | sed -n '1p')"
second="$(printf '%s\n' "$pair" | sed -n '2p')"
if [[ "$first" != "$base" && "$second" != "$base" ]]; then
  ok "an occupied base path yields a suffixed sibling"
else bad "an occupied base path yields a suffixed sibling ($first / $second)"; fi
# Both calls run in the same test process, so a pid-derived suffix would repeat.
if [[ "$first" != "$second" ]]; then
  ok "two allocations against the same base differ"
else bad "two allocations against the same base differ (both: $first)"; fi
check "the occupied base is left untouched" "EXISTING" "$(cat "$base")"

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
      CALICO_STATE_DIR="$E2E/state" E2E_COUNTER="$E2E/calls" RACE_HOOK="${RACE_HOOK:-}" \
      bash "$UPDATE_SH" "$1" 2>&1
}

printf '#!/bin/sh\necho "9.9.9 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-good"
printf '#!/bin/sh\necho "0.0.0 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-wrongver"
printf '#!/bin/sh\necho "9.9.99 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-superstring"
# Passes the pre-install check, then reports a different version once installed.
printf '#!/bin/sh\nn=$(cat "$E2E_COUNTER" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$E2E_COUNTER"\nif [ "$n" -le 1 ]; then echo "9.9.9 (Claude Code)"; echo "(patched)"; else echo "0.0.0 (Claude Code)"; echo "(patched)"; fi\n' > "${SANDBOX}/asset-flips"
# Verifies correctly, then deletes itself from its installed path — standing in
# for a concurrent prune landing between verification and the swap.
printf '#!/bin/sh\nn=$(cat "$E2E_COUNTER" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$E2E_COUNTER"\n[ "$n" -ge 2 ] && rm -f "$0"\necho "9.9.9 (Claude Code)"\necho "(patched)"\n' > "${SANDBOX}/asset-vanishes"

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

# --- 8c. installs are append-only ---------------------------------------------
# The load-bearing property: install never writes over a file that exists. A
# same-version reinstall lands on a unique suffixed sibling, so no preserve,
# restore, or interrupted-run recovery is ever needed — there is no intermediate
# state to recover from.

# A --force reinstall over an existing same-version file: the new build goes to
# a NEW path and the existing file is untouched byte for byte. Compared with
# cmp, never by executing a fixture.
e2e_reset "${SANDBOX}/asset-good"
printf 'PRE-EXISTING BYTES\n' > "$E2E/versions/9.9.9"
cp "$E2E/versions/9.9.9" "${SANDBOX}/pre-existing-copy"
ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
printf 'v9.9.9-linux-x64\n' > "$E2E/state/installed-tag"
out="$(e2e_run --force)"
rc=$?
check "e2e: a forced same-version reinstall succeeds" "0" "$rc"
if cmp -s "$E2E/versions/9.9.9" "${SANDBOX}/pre-existing-copy"; then
  ok "e2e: the pre-existing file is byte-identical after the reinstall"
else bad "e2e: the pre-existing file is byte-identical after the reinstall"; fi
new_target="$(readlink "$E2E/bin/calico-claude")"
if [[ "$new_target" != "$E2E/versions/9.9.9" && "$new_target" == "$E2E/versions/9.9.9."* && -f "$new_target" ]]; then
  ok "e2e: the reinstall landed on a new suffixed path ($(basename "$new_target"))"
else bad "e2e: the reinstall landed on a new suffixed path (got: ${new_target})"; fi
if cmp -s "$new_target" "${SANDBOX}/asset-good"; then
  ok "e2e: the suffixed path holds the downloaded build"
else bad "e2e: the suffixed path holds the downloaded build"; fi

# A late failure (passes pre-install, fails once installed) on a same-version
# rebuild: the previous target was never touched, so rollback is just the
# symlink pointing back at it.
e2e_reset "${SANDBOX}/asset-flips"; e2e_rebuild_releases "v9.9.9-linux-x64-2"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.9"; chmod +x "$E2E/versions/9.9.9"
ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
printf 'v9.9.9-linux-x64\n' > "$E2E/state/installed-tag"
out="$(e2e_run --run)"
rc=$?
check "e2e: a late failure on a same-version install fails the run" "1" "$rc"
check "e2e: the symlink is rolled back to the previous target" "$E2E/versions/9.9.9" "$(readlink "$E2E/bin/calico-claude")"
# Compared by content, not by running it: the flipping fixture keys its output
# off a counter file, so executing it would report the good version either way.
if cmp -s "$E2E/versions/9.9.9" "${SANDBOX}/asset-good"; then
  ok "e2e: the previous build is untouched after the rollback"
else bad "e2e: the previous build is untouched after the rollback"; fi

# A suffixed symlink target still reads as its bare version, so the next run
# reports "up to date" instead of reinstalling forever.
suffix_probe="${SANDBOX}/suffix-probe"
rm -rf "$suffix_probe"; mkdir -p "$suffix_probe/versions" "$suffix_probe/bin"
printf 'x\n' > "$suffix_probe/versions/9.9.9.4242"
ln -sf "$suffix_probe/versions/9.9.9.4242" "$suffix_probe/bin/calico-claude"
out="$(CALICO_BIN_LINK="$suffix_probe/bin/calico-claude" bash -c '
  stub="$1"; source "$stub"; get_installed_version; printf "%s" "$INSTALLED_VERSION"
' _ <(sed 's/^main "\$@"$/:/' "$UPDATE_SH"))"
check "get_installed_version reports the bare version for a suffixed target" "9.9.9" "$out"

# Pruning must recognise a suffixed current target and never delete it, even
# when it is older than everything else.
seed_versions "" 2.1.1 2.1.2 2.1.3 2.1.4 2.1.5
printf 'binary suffixed\n' > "${CALICO_VERSIONS_DIR}/2.1.0.4242"
touch -t 202601010500 "${CALICO_VERSIONS_DIR}/2.1.0.4242"
ln -sf "${CALICO_VERSIONS_DIR}/2.1.0.4242" "$CALICO_BIN_LINK"
check "prune never deletes a suffixed current target" "2.1.0.4242 2.1.3 2.1.4 2.1.5" "$(prune_with 3)"

# --- 8e. verification happens before the swap ---------------------------------
# The build is checked directly, not through BIN_LINK. Nothing is undone on
# failure because nothing was changed yet — so the launcher must be untouched.

e2e_reset "${SANDBOX}/asset-flips"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.8"; chmod +x "$E2E/versions/9.9.8"
ln -sf "$E2E/versions/9.9.8" "$E2E/bin/calico-claude"
out="$(e2e_run --run)"
check "e2e: a build failing its check fails the run" "1" "$?"
check "e2e: the launcher still points at the previous build" "$E2E/versions/9.9.8" "$(readlink "$E2E/bin/calico-claude")"
if printf '%s' "$out" | grep -q "Leaving .* untouched"; then
  ok "e2e: the failure is reported as leaving the launcher alone"
else bad "e2e: the failure is reported as leaving the launcher alone"; fi

# First install: there is no previous target, and the link must not be created.
e2e_reset "${SANDBOX}/asset-flips"
out="$(e2e_run --run)"
if [[ -e "$E2E/bin/calico-claude" || -L "$E2E/bin/calico-claude" ]]; then
  bad "e2e: no launcher is created when the build fails its check"
else ok "e2e: no launcher is created when the build fails its check"; fi

# --- 8e2. a slower run must not downgrade the launcher --------------------------
# Overlapping runs can be looking at different releases. If the newer one swaps
# first, an unconditional swap here would move the launcher backwards, and the
# tag record would then describe a build it no longer points at.

e2e_reset "${SANDBOX}/asset-good"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.8"; chmod +x "$E2E/versions/9.9.8"
ln -sf "$E2E/versions/9.9.8" "$E2E/bin/calico-claude"
printf '#!/bin/sh\necho "9.9.10 (Claude Code)"\necho "(patched)"\n' > "$E2E/versions/9.9.10"
chmod +x "$E2E/versions/9.9.10"
out="$(RACE_HOOK="ln -sf $E2E/versions/9.9.10 $E2E/bin/calico-claude" e2e_run --run)"
check "e2e: the launcher keeps the newer build another run installed" "$E2E/versions/9.9.10" "$(readlink "$E2E/bin/calico-claude")"
if printf '%s' "$out" | grep -q "newer than"; then
  ok "e2e: the skipped swap says why"
else bad "e2e: the skipped swap says why (got: ${out})"; fi
# The build it downloaded is still on disk; only the launcher was left alone.
if [[ -e "$E2E/versions/9.9.9" ]]; then
  ok "e2e: the downloaded build is kept for pruning"
else bad "e2e: the downloaded build is kept for pruning"; fi

# --- 8e3. the launcher update is serialized ------------------------------------
# Reading the current target, deciding, and swapping is a read-modify-write on
# shared state. A held commit lock must make this run leave the launcher alone
# rather than race; an abandoned one must not wedge updates forever.

e2e_reset "${SANDBOX}/asset-good"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.8"; chmod +x "$E2E/versions/9.9.8"
ln -sf "$E2E/versions/9.9.8" "$E2E/bin/calico-claude"
mkdir -p "$E2E/state/.commit-lock"
out="$(CALICO_COMMIT_WAIT=2 e2e_run --run)"
check "e2e: a held commit lock leaves the launcher alone" "$E2E/versions/9.9.8" "$(readlink "$E2E/bin/calico-claude")"
if [[ -e "$E2E/versions/9.9.9" ]]; then
  ok "e2e: the build is still installed when the commit lock is unavailable"
else bad "e2e: the build is still installed when the commit lock is unavailable"; fi
if [[ -d "$E2E/state/.commit-lock" ]]; then
  ok "e2e: another run's commit lock is not removed"
else bad "e2e: another run's commit lock is not removed"; fi

# An expired commit lock is NOT reclaimed. Every delete-and-reacquire protocol
# tried here let two runs enter the section the lock serializes; stopping is the
# safe direction, and unlike the run lock this one cannot be stranded by an
# ordinary kill since it spans two syscalls.
e2e_reset "${SANDBOX}/asset-good"
mkdir -p "$E2E/state/.commit-lock"
python3 -c "import os,sys; t=float(sys.argv[2]); os.utime(sys.argv[1],(t,t))" \
  "$E2E/state/.commit-lock" "$(( $(date +%s) - 3600 ))"
out="$(CALICO_COMMIT_WAIT=2 e2e_run --run)"
check "e2e: an expired commit lock does not fail the run" "0" "$?"
if [[ -d "$E2E/state/.commit-lock" ]]; then
  ok "e2e: an expired commit lock is left in place, not reclaimed"
else bad "e2e: an expired commit lock is left in place, not reclaimed"; fi
if [[ -e "$E2E/bin/calico-claude" || -L "$E2E/bin/calico-claude" ]]; then
  bad "e2e: the launcher is not moved while a commit lock is held"
else ok "e2e: the launcher is not moved while a commit lock is held"; fi
if printf '%s' "$out" | grep -q "remove it by hand"; then
  ok "e2e: an expired commit lock tells the user how to clear it"
else bad "e2e: an expired commit lock tells the user how to clear it (got: ${out})"; fi

# Same version, newer rebuild: comparing X.Y.Z alone would call these equal and
# let a stale base-tag run replace the rebuild.
e2e_reset "${SANDBOX}/asset-good"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.9"; chmod +x "$E2E/versions/9.9.9"
ln -sf "$E2E/versions/9.9.9" "$E2E/bin/calico-claude"
printf 'v9.9.9-linux-x64-2\n' > "$E2E/state/installed-tag"
out="$(e2e_run --force)"
check "e2e: a base-tag run does not replace a newer rebuild" "$E2E/versions/9.9.9" "$(readlink "$E2E/bin/calico-claude")"
check "e2e: the newer rebuild tag survives" "v9.9.9-linux-x64-2" "$(cat "$E2E/state/installed-tag")"

# --- 8e4. a destination pruned mid-run is not swapped to -------------------------
# The age-based in-flight protection assumes a run reaches the swap within
# PRUNE_MIN_AGE_SECONDS of installing. A suspended machine breaks that, and a
# later run can prune the destination this one is about to point at.

e2e_reset "${SANDBOX}/asset-vanishes"
cp "${SANDBOX}/asset-good" "$E2E/versions/9.9.8"; chmod +x "$E2E/versions/9.9.8"
ln -sf "$E2E/versions/9.9.8" "$E2E/bin/calico-claude"
# The fixture passes verification and then removes its own installed copy, which
# is what a concurrent prune during a long pause looks like from here.
out="$(e2e_run --run)"
check "e2e: a destination removed mid-run does not fail the run" "0" "$?"
check "e2e: the launcher is not pointed at a removed destination" "$E2E/versions/9.9.8" "$(readlink "$E2E/bin/calico-claude")"
if [[ -L "$E2E/bin/calico-claude" && -e "$E2E/bin/calico-claude" ]]; then
  ok "e2e: the launcher still resolves to a real file"
else bad "e2e: the launcher still resolves to a real file"; fi

# --- 8f. a launcher we do not manage is refused --------------------------------
# swap_symlink would mv over a regular file, and nothing could put it back.

e2e_reset "${SANDBOX}/asset-good"
printf 'USER OWNED\n' > "$E2E/bin/calico-claude"
out="$(e2e_run --run)"
check "e2e: a non-symlink launcher fails the run" "1" "$?"
check "e2e: the user's file is left exactly as it was" "USER OWNED" "$(cat "$E2E/bin/calico-claude")"
if printf '%s' "$out" | grep -q "not a symlink"; then
  ok "e2e: the refusal says why"
else bad "e2e: the refusal says why (got: ${out})"; fi

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
