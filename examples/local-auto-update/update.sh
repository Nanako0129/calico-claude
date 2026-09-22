#!/usr/bin/env bash
#
# calico update.sh — unattended local updater for patched Claude Code builds
# published by a Calico release repo (default: Nanako0129/calico-claude).
#
# It manages a SEPARATELY NAMED binary (default `calico-claude`) so the official
# `claude` symlink stays under Anthropic's own updater. See README.md next to
# this script for the SessionStart hook wiring.
#
# Modes:
#   --hook   Throttled entry point for the SessionStart hook. Never blocks:
#            if the last check was < THROTTLE_SECONDS ago it exits 0 immediately;
#            otherwise it records the timestamp, spawns a detached
#            `--unattended-run` and exits 0. stdin (the hook JSON payload) is
#            ignored.
#   --unattended-run  What --hook spawns and what the launchd agent runs: --run,
#            but with the repo read from ~/.claude/calico/config and every path
#            derived from HOME; CALICO_REPO and the CALICO_* path overrides are
#            ignored.
#   --run    Perform an update if a newer release exists. Verifies checksum and
#            build attestation (fail-hard) BEFORE installing; rolls back the
#            symlink if the post-install version check fails.
#   --force  Like --run, but skips the "already up to date" version gate so a
#            same-version rebuilt release can be reinstalled. Checksum,
#            attestation and post-verify still run (fail-hard) as usual.
#   --check  Report installed vs latest release. Makes no changes.
#
# Dependencies: bash 3.2+, curl, python3, and a sha256 checker (`shasum` on
# macOS, `sha256sum` on Linux). `gh` is optional and only used to verify build
# provenance attestations.
#
# Environment overrides (all optional). --hook and --unattended-run ignore
# CALICO_REPO, CALICO_BIN_LINK, CALICO_VERSIONS_DIR and CALICO_STATE_DIR; they
# read the repo from ~/.claude/calico/config (one line, `repo=<owner>/<name>`).
#   CALICO_REPO           GitHub repo publishing the patched releases.
#   CALICO_PLATFORM       Force a platform suffix (linux-x64, linux-arm64,
#                         macos-arm64, win32-x64, win32-arm64).
#   CALICO_BIN_LINK       Managed symlink path.
#   CALICO_VERSIONS_DIR   Directory holding installed versions.
#   CALICO_STATE_DIR      Lock/log/throttle state directory.
#   CALICO_KEEP_VERSIONS  How many old versions to keep (default 3, 0 = keep all).
#   CALICO_THROTTLE_SECONDS  Minimum seconds between --hook checks (default 3600).
#   GH_TOKEN / GITHUB_TOKEN  Used as a bearer token for the releases API. When
#                         neither is set, an authenticated `gh` supplies one;
#                         with neither, the call is anonymous (60/hour/address).

set -euo pipefail

# --- Constants ---------------------------------------------------------------
REPO="${CALICO_REPO:-Nanako0129/calico-claude}"
VERSIONS_DIR="${CALICO_VERSIONS_DIR:-${HOME}/.local/share/calico-claude/versions}"
BIN_LINK="${CALICO_BIN_LINK:-${HOME}/.local/bin/calico-claude}"
STATE_DIR="${CALICO_STATE_DIR:-${HOME}/.claude/calico}"
LOCK_DIR="${STATE_DIR}/.lock"
LAST_CHECK_FILE="${STATE_DIR}/last-check"
INSTALLED_TAG_FILE="${STATE_DIR}/installed-tag"
LOG_FILE="${STATE_DIR}/update.log"
THROTTLE_SECONDS="${CALICO_THROTTLE_SECONDS:-3600}"
KEEP_VERSIONS="${CALICO_KEEP_VERSIONS:-3}"
LOG_MAX_LINES=2000
API_URL="https://api.github.com/repos/${REPO}/releases?per_page=100"

# The unattended entry points -- --hook, and --unattended-run, which the hook
# spawns and the launchd agent runs -- take the repo and every path from HOME
# and one config file only, never from CALICO_* in the environment. Both inherit
# whatever environment Claude Code or launchd was started with, and a project's
# settings can put variables into a Claude Code session: honouring CALICO_REPO
# there would let one workspace point every later update at another repository
# (its own CI can produce matching checksums and attestations) and replace
# calico-claude for every project. The config file is written by the installer;
# until then a fork user writes it by hand (see README). --run, --force and
# --check are interactive and keep honouring the overrides, which the tests and
# a user at a terminal rely on. GH_HOST and GH_REPO are dropped so gh cannot be
# pointed at another host or repository for the attestation lookup.
use_unattended_settings() {
  STATE_DIR="${HOME}/.claude/calico"
  VERSIONS_DIR="${HOME}/.local/share/calico-claude/versions"
  BIN_LINK="${HOME}/.local/bin/calico-claude"
  LOCK_DIR="${STATE_DIR}/.lock"
  LAST_CHECK_FILE="${STATE_DIR}/last-check"
  INSTALLED_TAG_FILE="${STATE_DIR}/installed-tag"
  LOG_FILE="${STATE_DIR}/update.log"
  REPO="Nanako0129/calico-claude"
  local configured
  # `|| true`: with no config file sed fails, and under pipefail and set -e that
  # ended the whole script -- measured, every --hook exited 1 before doing
  # anything on a machine without the file.
  configured="$( { sed -n 's/^repo=\([A-Za-z0-9._-][A-Za-z0-9._-]*\/[A-Za-z0-9._-][A-Za-z0-9._-]*\)$/\1/p' \
    "${STATE_DIR}/config" 2>/dev/null || true; } | head -n 1)"
  if [[ -n "$configured" ]]; then
    REPO="$configured"
  fi
  API_URL="https://api.github.com/repos/${REPO}/releases?per_page=100"
  unset GH_HOST GH_REPO
}

# Populated by cleanup trap.
TMP_DIR=""

# 1 only when THIS run created LOCK_DIR. A run that proceeds past someone
# else's aged lock must not remove that lock on exit.
LOCK_CREATED=0

# Set to 1 by the --force mode. When forcing, perform_update skips the
# "already up to date" version gate (but still runs checksum, attestation and
# post-verify) so a same-version rebuilt release can be reinstalled.
FORCE=0

# --- Helpers -----------------------------------------------------------------
log() {
  printf '%s [calico] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  # Only ever remove a lock this run created. Removing another run's lock is
  # where every past lock defect came from.
  if [[ "$LOCK_CREATED" == "1" && -d "$LOCK_DIR" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

# Sets: RELEASE_SUFFIX, ASSET, IS_MACOS.
# Mirrors detect_platform() in install-patched-claude.sh; keep the two in sync.
detect_platform() {
  IS_MACOS=0

  if [[ -n "${CALICO_PLATFORM:-}" ]]; then
    RELEASE_SUFFIX="$CALICO_PLATFORM"
  else
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
      Linux)
        case "$arch" in
          x86_64)        RELEASE_SUFFIX="linux-x64" ;;
          aarch64|arm64) RELEASE_SUFFIX="linux-arm64" ;;
          *) fail "Unsupported Linux architecture: ${arch}" ;;
        esac
        ;;
      Darwin)
        case "$arch" in
          arm64) RELEASE_SUFFIX="macos-arm64" ;;
          *) fail "Unsupported macOS architecture: ${arch}. Only Apple Silicon is supported." ;;
        esac
        ;;
      MINGW*|MSYS*|CYGWIN*)
        case "$arch" in
          x86_64|amd64)  RELEASE_SUFFIX="win32-x64" ;;
          aarch64|arm64) RELEASE_SUFFIX="win32-arm64" ;;
          *) fail "Unsupported Windows architecture: ${arch}" ;;
        esac
        ;;
      *)
        fail "Unsupported operating system: ${os}"
        ;;
    esac
  fi

  case "$RELEASE_SUFFIX" in
    linux-x64|linux-arm64) ASSET="claude.native.patched" ;;
    macos-arm64)           ASSET="claude.native.macos.patched"; IS_MACOS=1 ;;
    win32-x64|win32-arm64) ASSET="claude.native.windows.patched.exe" ;;
    *) fail "Unknown platform suffix: ${RELEASE_SUFFIX}" ;;
  esac
}

# Leading X.Y.Z token of a `--version` line. Substring matching is not safe
# here: "2.1.24" is a substring of "2.1.240", so a mislabeled release would pass
# the very gate meant to catch it.
version_token() {
  printf '%s' "$1" | sed -n '1s/^[^0-9]*\([0-9][0-9.]*[0-9]\).*/\1/p'
}

# True when `--version` output reports exactly $2 and carries the patched marker.
version_output_matches() {
  local output="$1" expected="$2"
  [[ "$output" == *"(patched)"* ]] || return 1
  [[ "$(version_token "$output")" == "$expected" ]]
}

# Rebuild rank of a release tag. A corrected build is republished under a numeric
# suffix (v2.1.240-macos-arm64-2); the base tag ranks 1. Platform suffixes such
# as `x64` or `arm64` are not bare integers, so a base tag never misreads as a
# rebuild.
tag_rebuild_rank() {
  local suffix="${1##*-}"
  if [[ "$suffix" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$suffix"
  else
    printf '1\n'
  fi
}

# Rank of the tag this script last installed. Absent (first run, or an install
# predating this file) means the base build, so a base-tag release still reads
# as "nothing newer" and nothing is reinstalled needlessly.
#
# The record is trusted only when its version is the installed version. An
# install that bypassed this script leaves the record describing an older
# build: measured 2026-09-23, a record of v2.1.278-macos-arm64-2 beside an
# installed 2.1.280 made v2.1.280-macos-arm64-2 read as "not newer", so that
# rebuild was never installed. A stale record now reads as rank 0, below every
# published tag, so the latest rebuild of the installed version is reinstalled
# once and the record is rewritten.
installed_rebuild_rank() {
  local recorded recorded_version
  recorded="$(cat "$INSTALLED_TAG_FILE" 2>/dev/null || true)"
  if [[ -z "$recorded" ]]; then
    printf '1\n'
    return
  fi
  recorded_version="$(printf '%s' "$recorded" | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)-.*/\1/p')"
  if [[ -n "${INSTALLED_VERSION:-}" && "$recorded_version" != "$INSTALLED_VERSION" ]]; then
    printf '0\n'
    return
  fi
  tag_rebuild_rank "$recorded"
}

# Verify "<sha256>  <file>" lines in $1 against files in the current directory.
sha256_check() {
  local list="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$list"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$list"
  else
    fail "Missing required command: shasum or sha256sum"
  fi
}

# A lock older than this is assumed abandoned (SIGKILL, power loss, reboot) and
# is IGNORED, never removed. Any real run finishes far inside an hour.
LOCK_MAX_AGE_SECONDS=3600

# Age of a path in seconds, or non-zero when it cannot be determined.
#
# Exit status cannot drive the fallback here: GNU `stat -f` means
# --file-system, so on Linux it SUCCEEDS with unrelated multi-line output and a
# `-f || -c` chain never reaches the second form. Try the GNU spelling first and
# validate the output instead.
path_age_seconds() {
  local target="$1"
  local mtime
  mtime="$(stat -c %Y "$target" 2>/dev/null || true)"
  if [[ ! "$mtime" =~ ^[0-9]+$ ]]; then
    mtime="$(stat -f %m "$target" 2>/dev/null || true)"
  fi
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$(( $(date +%s) - mtime ))"
}

# The lock is an efficiency device, not a correctness one: installs are
# append-only, so two concurrent updaters waste a download rather than break an
# installation. That is why there is no claim protocol here — this run NEVER
# deletes, moves, or takes over a lock it did not create (deleting another
# process's lock is where every past lock defect came from). A young foreign
# lock means someone else is on it, so skip the duplicate work; an aged or
# unmeasurable one is assumed abandoned and simply ignored.
acquire_lock() {
  mkdir -p "$STATE_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_CREATED=1
  else
    local age
    if age="$(path_age_seconds "$LOCK_DIR")" && (( age < LOCK_MAX_AGE_SECONDS )); then
      log "Another update is already in progress (lock is ${age}s old); exiting."
      exit 0
    fi
    log "Ignoring lock ${LOCK_DIR} (age ${age:-unknown}s, older than ${LOCK_MAX_AGE_SECONDS}s or unmeasurable); proceeding without holding it."
  fi
  trap cleanup EXIT
}

# Installed version = leading X.Y.Z of the symlink target's basename. Installs
# are append-only, so a reinstall of a present version lands on a suffixed
# sibling (e.g. "2.1.240.4242") — the whole basename is not always a bare
# version. Does NOT launch the binary.
get_installed_version() {
  local target
  if [[ ! -L "$BIN_LINK" ]]; then
    # Not a symlink we manage; still try to derive something sensible.
    if [[ -e "$BIN_LINK" ]]; then
      log "WARNING: ${BIN_LINK} is not a symlink; cannot derive installed version from link target."
    fi
    INSTALLED_VERSION=""
    return
  fi
  target="$(readlink "$BIN_LINK")"
  INSTALLED_VERSION="$(basename "$target" | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
}

# True if the currently installed binary carries the Calico "(patched)"
# version marker. Used to detect the official autoupdater overwriting the
# patched build with a same-version official binary.
installed_is_patched() {
  local version_output
  version_output="$("$BIN_LINK" --version 2>/dev/null || true)"
  [[ "$version_output" == *"(patched)"* ]]
}

# Query the releases list, pick the highest semver whose tag matches
# ^v(X.Y.Z)-<suffix>(-<rebuild>)?$ and that carries the expected asset.
# Sets: LATEST_VERSION, LATEST_TAG, ASSET_URL, CHECKSUMS_URL (may be empty).
# Returns 0 when a release was found, 1 when none matched.
query_latest_release() {
  require_cmd curl
  require_cmd python3

  local json_file
  json_file="$(mktemp)" || fail "Failed to create temp file for release metadata"

  # Built as one non-empty array: bash 3.2 (stock on macOS) treats "${a[@]}"
  # on an EMPTY array as an unbound variable under `set -u`, so an optional
  # token must never be its own array.
  local -a curl_args=(
    -fsSL
    -H "Accept: application/vnd.github+json"
    -H "User-Agent: calico-claude-updater"
  )
  # Anonymous, this call is capped at 60 an hour per address, and neither
  # launchd nor the SessionStart hook exports a token: on the maintainer's
  # machine 4 of 12 consecutive checks got a 403, one of them the only check
  # after 2.1.280 shipped, and the hook stamps its throttle before querying, so
  # each 403 also cost the next hour. An authenticated `gh` — already this
  # script's optional dependency for attestation — is the credential most
  # installs have, so it is the fallback. An explicit token still wins, and an
  # unauthenticated or missing gh leaves the request anonymous as before.
  local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"
  fi

  # The header travels on stdin (`-H @-`), never in curl's argv: argv is
  # readable by other local users through `ps` for as long as the request runs,
  # and the gh fallback would otherwise put a keychain-held credential there
  # for users who never exported one. printf is a builtin, so it spawns no
  # process whose argv could carry the token either. Measured: the running
  # curl's `ps -ww` line read `curl -fsS -H @- ... <url>`, and the request
  # authenticated (rate_limit reported 5000) under bash 5.3 and /bin/bash 3.2.
  local curl_rc=0
  if [[ -n "$token" ]]; then
    printf 'Authorization: Bearer %s\n' "$token" \
      | curl "${curl_args[@]}" -H @- "$API_URL" -o "$json_file" || curl_rc=$?
  else
    curl "${curl_args[@]}" "$API_URL" -o "$json_file" || curl_rc=$?
  fi
  if (( curl_rc != 0 )); then
    rm -f "$json_file"
    fail "Failed to query GitHub releases API for ${REPO}"
  fi

  local parsed rc
  set +e
  parsed="$(python3 - "$ASSET" "$RELEASE_SUFFIX" "$json_file" <<'PY'
import json, re, sys

asset = sys.argv[1]
suffix = sys.argv[2]
json_file = sys.argv[3]
# Rebuilt releases carry a numeric suffix (v2.1.235-macos-arm64-2). Rank them
# above the base tag for the same version, matching install-patched-claude.sh.
pat = re.compile(r'^v(\d+)\.(\d+)\.(\d+)-' + re.escape(suffix) + r'(?:-(\d+))?$')

try:
    with open(json_file, encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(2)

if not isinstance(data, list):
    sys.exit(2)

best = None
for rel in data:
    if not isinstance(rel, dict):
        continue
    # Drafts and prereleases are never installed unattended. A prerelease
    # carrying a mistyped high version would otherwise become the target of
    # every machine and then outrank each correct release after it.
    if rel.get("draft") or rel.get("prerelease"):
        continue
    tag = rel.get("tag_name", "") or ""
    m = pat.match(tag)
    if not m:
        continue
    ver = tuple(int(x) for x in m.group(1, 2, 3))
    rank = int(m.group(4) or "1")
    asset_url = checksums_url = None
    for a in rel.get("assets", []) or []:
        name = a.get("name")
        if name == asset:
            asset_url = a.get("browser_download_url")
        elif name == "checksums.txt":
            checksums_url = a.get("browser_download_url")
    if not asset_url:
        continue
    key = (ver, rank)
    cand = (key, tag, "%d.%d.%d" % ver, asset_url, checksums_url or "")
    if best is None or key > best[0]:
        best = cand

if best is None:
    sys.exit(3)

print(best[2])
print(best[1])
print(best[3])
print(best[4])
PY
)"
  rc=$?
  set -e
  rm -f "$json_file"

  case "$rc" in
    0) ;;
    3) return 1 ;;  # no matching release
    2) fail "Failed to parse GitHub releases JSON" ;;
    *) fail "Release query failed (rc=${rc})" ;;
  esac

  LATEST_VERSION="$(printf '%s\n' "$parsed" | sed -n '1p')"
  LATEST_TAG="$(printf '%s\n' "$parsed" | sed -n '2p')"
  ASSET_URL="$(printf '%s\n' "$parsed" | sed -n '3p')"
  CHECKSUMS_URL="$(printf '%s\n' "$parsed" | sed -n '4p')"

  [[ -n "$LATEST_VERSION" && -n "$ASSET_URL" ]] || fail "Incomplete release metadata parsed"
  return 0
}

# Compare dotted semver: echoes "newer" if $1 > $2, "same" if equal, "older" otherwise.
semver_relation() {
  python3 - "$1" "$2" <<'PY'
import sys
def parse(v):
    return tuple(int(x) for x in v.split("."))
a = parse(sys.argv[1]); b = parse(sys.argv[2])
print("newer" if a > b else ("same" if a == b else "older"))
PY
}

verify_checksum() {
  local dir="$1"
  local checksums_file="${dir}/checksums.txt"

  [[ -s "$checksums_file" ]] || fail "checksums.txt is missing or empty; refusing to install"

  # Extract only the line for our asset so that unrelated entries (missing
  # files) do not make the checker error out for the wrong reason.
  local filtered="${dir}/checksums.selected.txt"
  # Escape regex metacharacters: the asset name contains dots, which would
  # otherwise match any character and let a decoy entry satisfy the gate.
  local asset_re="${ASSET//./\\.}"
  grep -E "[[:space:]]\*?${asset_re}\$" "$checksums_file" > "$filtered" || \
    fail "No checksum entry for ${ASSET} in checksums.txt"

  ( cd "$dir" && sha256_check "$(basename "$filtered")" ) >/dev/null 2>&1 || \
    fail "Checksum verification FAILED for ${ASSET}; refusing to install"

  log "Checksum verified for ${ASSET}"
}

verify_attestation() {
  local file="$1"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    # `--repo` alone accepts an attestation from any workflow and any ref in the
    # repository -- a dispatch from a branch, or a workflow added on one. The
    # release workflow and main are pinned. Measured 2026-09-23 with gh 2.97.0:
    # the released v2.1.280-macos-arm64-2 asset verifies with both constraints,
    # and --source-ref refs/heads/not-main fails with "expected
    # SourceRepositoryRef to be refs/heads/not-main, got refs/heads/main". A gh
    # too old for these flags fails too, and is named as the reason rather than
    # retried without them.
    local output
    if output="$(gh attestation verify "$file" --repo "$REPO" \
      --signer-workflow "${REPO}/.github/workflows/patch-claude.yml" \
      --source-ref refs/heads/main 2>&1)"; then
      log "Attestation verified via gh for ${ASSET}"
    elif [[ "$output" == *"unknown flag"* ]]; then
      fail "Installed gh cannot pin the signing workflow and ref (--signer-workflow/--source-ref); update gh. Refusing to install ${ASSET}"
    else
      fail "Attestation verification FAILED for ${ASSET}; refusing to install"
    fi
  else
    log "WARNING: gh unavailable or not authenticated; skipping attestation verification"
  fi
}

# An install path that is guaranteed not to exist yet.
#
# Installs are append-only: never write over a file that exists. --force, the
# unpatched self-heal, and a same-version rebuild would otherwise install over
# the current symlink target, and every preserve/restore/recover mechanism this
# script ever needed existed to undo exactly that.
#
# The suffix comes from mktemp rather than the pid. Pids are unique only among
# processes alive at the same moment, not over time: a suffixed build that
# survives pruning can still be on disk when a later run is assigned the same
# pid, and `install` would then overwrite it — reopening the very hole this
# design closes. mktemp creates the file exclusively, which also settles the
# race between two runs choosing a name at the same instant.
allocate_dest() {
  local base="$1"
  # `set -o noclobber` makes this redirect an O_EXCL create: it succeeds only if
  # it created the file. Testing `[[ -e ]]` first would not do — two overlapping
  # runs can both find the base absent and then install over each other, which
  # an ignored lock explicitly permits. Reserving it is the test.
  if (set -o noclobber; : > "$base") 2>/dev/null; then
    printf '%s\n' "$base"
    return 0
  fi
  mktemp "${base}.XXXXXX"
}

# Atomically point BIN_LINK at $1 (an absolute target path).
swap_symlink() {
  local target="$1"
  local tmp="${BIN_LINK}.calico-tmp.$$"
  ln -s "$target" "$tmp"
  mv -f "$tmp" "$BIN_LINK"
}

# Keep the newest KEEP_VERSIONS entries in VERSIONS_DIR and delete the rest. The
# current symlink target is always kept — after a rollback it may be older than
# all of them, in which case it is retained on top of the newest KEEP_VERSIONS.
# KEEP_VERSIONS=0 (or a non-numeric value) disables pruning entirely.
# Entries are ordered by mtime (newest first) so hand-made names such as
# "2.1.223.pre-something" are handled without a semver parse. The current
# target is matched by its literal basename, so a pid-suffixed append-only
# install ("2.1.240.4242") is protected exactly like a bare one.
prune_old_versions() {
  [[ "$KEEP_VERSIONS" =~ ^[0-9]+$ ]] || return 0
  (( KEEP_VERSIONS > 0 )) || return 0
  [[ -d "$VERSIONS_DIR" ]] || return 0

  local current=""
  [[ -L "$BIN_LINK" ]] && current="$(basename "$(readlink "$BIN_LINK")")"

  local -a entries=()
  local name
  # ls -t sorts by mtime, newest first. Names here are version strings written
  # by this script, so they never contain newlines.
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ -f "${VERSIONS_DIR}/${name}" ]] || continue
    entries+=("$name")
  done < <(ls -t "$VERSIONS_DIR" 2>/dev/null)

  local kept=0
  for name in "${entries[@]:-}"; do
    [[ -n "$name" ]] || continue
    if [[ "$name" == "$current" ]]; then
      # Always kept, and counted, so KEEP_VERSIONS=3 means three builds on disk
      # in the normal case rather than four.
      kept=$((kept + 1))
      continue
    fi
    kept=$((kept + 1))
    if (( kept <= KEEP_VERSIONS )); then
      continue
    fi
    rm -f "${VERSIONS_DIR}/${name}" && log "Pruned old version ${name}"
  done
}

# Keep the detached --run log from growing without bound.
rotate_log() {
  [[ -f "$LOG_FILE" ]] || return 0
  local lines
  lines="$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d ' ')"
  [[ "$lines" =~ ^[0-9]+$ ]] || return 0
  (( lines > LOG_MAX_LINES )) || return 0
  local tmp="${LOG_FILE}.trim.$$"
  tail -n "$((LOG_MAX_LINES / 2))" "$LOG_FILE" > "$tmp" 2>/dev/null && mv -f "$tmp" "$LOG_FILE"
  rm -f "$tmp" 2>/dev/null || true
}

perform_update() {
  acquire_lock
  detect_platform

  get_installed_version
  # A launcher that is not a symlink is not ours to replace. swap_symlink would
  # mv over it, and nothing here could put a user's own executable back.
  if [[ -e "$BIN_LINK" && ! -L "$BIN_LINK" ]]; then
    fail "${BIN_LINK} exists but is not a symlink; refusing to replace it. Move it aside if it should be managed by this updater."
  fi
  log "Installed version: ${INSTALLED_VERSION:-<unknown>} (${RELEASE_SUFFIX})"

  if ! query_latest_release; then
    log "No matching ${RELEASE_SUFFIX} release found for ${REPO}; nothing to do. Exiting."
    exit 0
  fi
  log "Latest release: ${LATEST_VERSION} (tag ${LATEST_TAG})"

  if [[ -n "$INSTALLED_VERSION" ]]; then
    local rel
    rel="$(semver_relation "$LATEST_VERSION" "$INSTALLED_VERSION")"
    if [[ "$rel" == "newer" ]]; then
      : # proceed to install
    elif [[ "$rel" == "same" ]] &&
      (( $(tag_rebuild_rank "$LATEST_TAG") > $(installed_rebuild_rank) )); then
      # Same version, but republished as a corrected build. Without this the
      # unattended path would report "up to date" and no user would ever receive
      # a rebuild until upstream happened to ship a new version.
      log "Installed ${INSTALLED_VERSION} matches latest, but ${LATEST_TAG} is a newer rebuild; reinstalling."
    elif [[ "$rel" == "same" ]] && ! installed_is_patched; then
      # Same version but the official autoupdater (or a manual `claude
      # install`) overwrote the patched binary — self-heal by reinstalling
      # the patched build of the same version.
      log "Installed ${INSTALLED_VERSION} matches latest but is NOT patched (official binary detected); reinstalling patched build."
    elif [[ "$FORCE" == "1" ]]; then
      # --force: reinstall even when already up to date and already patched
      # (e.g. the release was rebuilt at the same version). Checksum,
      # attestation and post-verify below still run unconditionally.
      log "Installed version ${INSTALLED_VERSION} is up to date (latest ${LATEST_VERSION}), but --force given; reinstalling."
    elif [[ "$rel" == "older" ]]; then
      # The installed version is above every published release, so nothing
      # will ever be offered again until upstream passes it. That is how a
      # mistaken high-numbered release would silently stall updates.
      log "WARNING: installed ${INSTALLED_VERSION} is newer than the latest release ${LATEST_VERSION}; no update will be offered until a newer release is published."
      prune_old_versions
      exit 0
    else
      log "Installed version ${INSTALLED_VERSION} is up to date (latest ${LATEST_VERSION}); nothing to do. Exiting."
      prune_old_versions
      exit 0
    fi
  fi

  # --- Download -------------------------------------------------------------
  TMP_DIR="$(mktemp -d)" || fail "Failed to create temp download dir"
  local asset_path="${TMP_DIR}/${ASSET}"
  log "Downloading ${ASSET} (${LATEST_TAG})"
  # -sS: no progress meter (this log is appended to unattended), errors still shown.
  curl -fsSL "$ASSET_URL" -o "$asset_path" || fail "Failed to download ${ASSET}"

  if [[ -n "$CHECKSUMS_URL" ]]; then
    curl -fsSL "$CHECKSUMS_URL" -o "${TMP_DIR}/checksums.txt" || fail "Failed to download checksums.txt"
  else
    fail "Release ${LATEST_TAG} has no checksums.txt asset; refusing to install"
  fi

  # --- Verify (fail-hard, BEFORE install) -----------------------------------
  verify_checksum "$TMP_DIR"
  verify_attestation "$asset_path"

  # --- Pre-install artifact check -------------------------------------------
  # Run the downloaded file where it sits. Cheap, and it keeps a bad artifact
  # out of VERSIONS_DIR entirely instead of leaving it there for pruning.
  chmod +x "$asset_path" || fail "Failed to make ${ASSET} executable"
  if (( IS_MACOS )); then
    xattr -d com.apple.quarantine "$asset_path" 2>/dev/null || true
  fi
  local artifact_version
  artifact_version="$("$asset_path" --version 2>&1 || true)"
  if ! version_output_matches "$artifact_version" "$LATEST_VERSION"; then
    fail "Downloaded ${ASSET} reports '${artifact_version//$'\n'/ | }', expected ${LATEST_VERSION} and (patched); refusing to install"
  fi
  log "Artifact verified before install: ${artifact_version//$'\n'/ | }"

  # --- Install --------------------------------------------------------------
  mkdir -p "$VERSIONS_DIR"
  local dest
  dest="$(allocate_dest "${VERSIONS_DIR}/${LATEST_VERSION}")" ||
    fail "Failed to allocate an install path under ${VERSIONS_DIR}"
  if ! install -m 0755 "$asset_path" "$dest"; then
    fail "Failed to install binary to ${dest}"
  fi
  if (( IS_MACOS )); then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
  fi
  log "Installed patched binary to ${dest}"

  # --- Verify the build before it becomes the launcher ----------------------
  # Checked directly, not through BIN_LINK. Reading it through the symlink is
  # unsound once runs can overlap: another updater may have pointed the link at
  # its own build between our swap and our check, and we would then judge -- and
  # roll back -- someone else's successful install. Verifying first also removes
  # the need to undo a swap at all.
  local version_output
  version_output="$("$dest" --version 2>&1 || true)"
  if ! version_output_matches "$version_output" "$LATEST_VERSION"; then
    log "ERROR: the installed build reports '${version_output//$'\n'/ | }', expected ${LATEST_VERSION} and (patched). Leaving ${BIN_LINK} untouched."
    # $dest stays in VERSIONS_DIR and is pruned later like any other old build.
    exit 1
  fi
  log "Verified before swap: ${version_output//$'\n'/ | }"

  # --- Point the launcher at it ---------------------------------------------
  mkdir -p "$(dirname "$BIN_LINK")"

  # The tag record and the symlink describe one fact between them, so a failure
  # to write the record must not leave the launcher advanced. Treating that write
  # as merely "degraded" could strand a high rebuild rank from an older version
  # on top of a newer one, after which a later rebuild reads as already current
  # and becomes unreachable even with --force. Written before the swap: a
  # failure here is caught while the launcher is still untouched.
  local previous_tag
  previous_tag="$(cat "$INSTALLED_TAG_FILE" 2>/dev/null || true)"
  if ! printf '%s\n' "$LATEST_TAG" > "$INSTALLED_TAG_FILE" 2>/dev/null; then
    log "Cannot write ${INSTALLED_TAG_FILE}; leaving ${BIN_LINK} unchanged so the record and the launcher stay consistent."
    exit 0
  fi

  # The swap can still fail — an unwritable launcher directory, or a leftover
  # .calico-tmp path defeating `ln`. The record already names the new build at
  # this point, and leaving it there would make a later same-version rebuild
  # compare equal and exit as up to date. Put the old record back before failing.
  if ! swap_symlink "$dest"; then
    if [[ -n "$previous_tag" ]]; then
      printf '%s\n' "$previous_tag" > "$INSTALLED_TAG_FILE" 2>/dev/null || true
    else
      rm -f "$INSTALLED_TAG_FILE" 2>/dev/null || true
    fi
    fail "Failed to point ${BIN_LINK} at ${dest}; the release record was restored."
  fi
  log "Symlink ${BIN_LINK} -> ${dest}"
  log "Update to ${LATEST_TAG} complete."

  prune_old_versions
}

do_check() {
  detect_platform
  get_installed_version
  local installed_display="${INSTALLED_VERSION:-<unknown>}"
  if query_latest_release; then
    printf 'Platform:       %s\n' "$RELEASE_SUFFIX"
    printf 'Installed:      %s\n' "$installed_display"
    printf 'Latest release: %s (tag %s)\n' "$LATEST_VERSION" "$LATEST_TAG"
    if [[ -n "$INSTALLED_VERSION" ]]; then
      case "$(semver_relation "$LATEST_VERSION" "$INSTALLED_VERSION")" in
        newer) printf 'Status:         update available\n' ;;
        older) printf 'Status:         installed is newer than latest release\n' ;;
        same)
          # Same version is not the same as nothing to do: --run also reinstalls
          # for a newer rebuild of this version, or when the official updater
          # has replaced the patched binary. Reporting "up to date" in either
          # case would tell the user the opposite of what --run is about to do.
          if (( $(tag_rebuild_rank "$LATEST_TAG") > $(installed_rebuild_rank) )); then
            printf 'Status:         rebuild available (%s)\n' "$LATEST_TAG"
          elif ! installed_is_patched; then
            printf 'Status:         reinstall needed (installed binary is not patched)\n'
          else
            printf 'Status:         up to date\n'
          fi
          ;;
      esac
    fi
  else
    printf 'Platform:       %s\n' "$RELEASE_SUFFIX"
    printf 'Installed:      %s\n' "$installed_display"
    printf 'Latest release: none (no matching %s release published yet)\n' "$RELEASE_SUFFIX"
  fi
}

do_hook() {
  # Never block session startup. Ignore stdin (the hook JSON payload).
  mkdir -p "$STATE_DIR"
  local now last
  now="$(date +%s)"
  last="$(cat "$LAST_CHECK_FILE" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0

  if (( now - last < THROTTLE_SECONDS )); then
    exit 0
  fi

  # An unwritable stamp must not turn the "never blocks" hook into a failure.
  printf '%s\n' "$now" > "$LAST_CHECK_FILE" 2>/dev/null || \
    log "WARNING: could not write ${LAST_CHECK_FILE}; throttling is degraded."
  rotate_log
  nohup bash "$0" --unattended-run < /dev/null >> "$LOG_FILE" 2>&1 &
  disown
  exit 0
}

main() {
  local mode="${1:-}"
  case "$mode" in
    --hook)  use_unattended_settings; do_hook ;;
    --unattended-run) use_unattended_settings; perform_update ;;
    --run)   perform_update ;;
    --force) FORCE=1; perform_update ;;
    --check) do_check ;;
    *)
      cat >&2 <<EOF
Usage: $0 [--hook|--run|--force|--check]

  --hook   Throttled SessionStart entry point (spawns detached --unattended-run, never blocks).
  --unattended-run  --run for the hook and the launchd agent: repo from the config file only.
  --run    Update if a newer verified release exists.
  --force  Reinstall even when already up to date (skips only the version gate).
  --check  Report installed vs latest release without changing anything.
EOF
      exit 2
      ;;
  esac
}

main "$@"
