#!/usr/bin/env bash

set -euo pipefail

REPO_SLUG="${PATCH_CLAUDE_REPO:-Nanako0129/calico-claude}"
API_BASE_URL="https://api.github.com/repos/${REPO_SLUG}"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "Error: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      case "$arch" in
        x86_64)
          RELEASE_SUFFIX="linux-x64"
          ASSET_NAME="claude.native.patched"
          ;;
        aarch64|arm64)
          RELEASE_SUFFIX="linux-arm64"
          ASSET_NAME="claude.native.patched"
          ;;
        *)
          fail "Unsupported Linux architecture: ${arch}"
          ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        arm64)
          RELEASE_SUFFIX="macos-arm64"
          ASSET_NAME="claude.native.macos.patched"
          ;;
        *)
          fail "Unsupported macOS architecture: ${arch}. Only Apple Silicon is supported."
          ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      case "$arch" in
        x86_64|amd64)
          RELEASE_SUFFIX="win32-x64"
          ASSET_NAME="claude.native.windows.patched.exe"
          ;;
        aarch64|arm64)
          RELEASE_SUFFIX="win32-arm64"
          ASSET_NAME="claude.native.windows.patched.exe"
          ;;
        *)
          fail "Unsupported Windows architecture: ${arch}"
          ;;
      esac
      ;;
    *)
      fail "Unsupported operating system: ${os}"
      ;;
  esac
}

is_windows_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

find_existing_claude() {
  local claude_path
  claude_path="$(command -v claude || true)"
  if [[ -z "$claude_path" ]]; then
    cat >&2 <<'EOF'
Error: Could not find an existing native Claude installation.

Install the official native Claude binary first, then run this installer again:

  curl -fsSL https://claude.ai/install.sh | bash

EOF
    exit 1
  fi

  CLAUDE_PATH="$claude_path"
}

detect_installed_version() {
  local version_output
  version_output="$("$CLAUDE_PATH" --version 2>/dev/null || true)"

  if [[ "$version_output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    CLAUDE_VERSION="${BASH_REMATCH[1]}"
  else
    fail "Could not parse Claude version from: ${version_output:-<empty>}"
  fi
}

github_api_get() {
  local url="$1"
  local output_file="$2"

  # Anonymous calls are capped at 60 an hour per address, and a shared egress
  # (a VPN, an office NAT) spends that for everyone behind it: a re-run on a
  # Windows box behind Cloudflare WARP failed here with the limit at
  # remaining=0. An authenticated gh is the credential most users already have,
  # so it comes after the explicit variables and before anonymous.
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [[ -z "$token" ]] && command -v gh >/dev/null 2>&1; then
    token="$(gh auth token 2>/dev/null || true)"
  fi

  # The header travels on stdin (`-H @-`), never in curl's argv, which other
  # local users can read through `ps` while the request runs. printf is a
  # builtin, so no process carries the token in its argv at all. See the same
  # block in examples/local-auto-update/update.sh for the measurement.
  if [[ -n "$token" ]]; then
    printf 'Authorization: Bearer %s\n' "$token" | curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: patch-claude-code-installer" \
      -H @- \
      "$url" \
      -o "$output_file"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: patch-claude-code-installer" \
      "$url" \
      -o "$output_file"
  fi
}

fetch_release_metadata() {
  require_cmd curl
  require_cmd python3

  local release_json_file release_metadata release_api_url expected_tag
  release_json_file="$(mktemp)" || fail "Failed to create temporary file for release metadata"
  expected_tag="v${CLAUDE_VERSION}-${RELEASE_SUFFIX}"
  release_api_url="${API_BASE_URL}/releases?per_page=100"

  github_api_get "$release_api_url" "$release_json_file" || {
    rm -f "$release_json_file"
    fail "Could not list patched releases for Claude ${CLAUDE_VERSION} on ${RELEASE_SUFFIX}"
  }

  if [[ ! -s "$release_json_file" ]]; then
    rm -f "$release_json_file"
    fail "Failed to fetch release metadata"
  fi

  release_metadata="$(
    python3 - "$ASSET_NAME" "$release_json_file" "$expected_tag" <<'PY'
import json
import re
import sys

asset_name = sys.argv[1]
release_json_file = sys.argv[2]
expected_tag = sys.argv[3]

with open(release_json_file, encoding="utf-8") as handle:
    releases = json.load(handle)

if not isinstance(releases, list):
    raise SystemExit(1)

pattern = re.compile(rf"^{re.escape(expected_tag)}(?:-(\d+))?$")
candidates = []
for release in releases:
    if not isinstance(release, dict) or release.get("draft"):
        continue
    tag = release.get("tag_name", "")
    match = pattern.fullmatch(tag)
    if not match:
        continue
    rank = int(match.group(1) or "1")
    candidates.append((rank, release))

for _, release in sorted(candidates, key=lambda item: item[0], reverse=True):
    for asset in release.get("assets", []):
        if asset.get("name") == asset_name:
            print(release["tag_name"])
            print(asset["browser_download_url"])
            raise SystemExit(0)

raise SystemExit(1)
PY
  )" || {
    rm -f "$release_json_file"
    fail "Could not find the ${ASSET_NAME} asset in ${expected_tag} or a verified rebuild suffix"
  }

  rm -f "$release_json_file"
  RELEASE_METADATA="$release_metadata"

  RELEASE_TAG="$(printf '%s\n' "$RELEASE_METADATA" | sed -n '1p')"
  DOWNLOAD_URL="$(printf '%s\n' "$RELEASE_METADATA" | sed -n '2p')"

  [[ -n "$RELEASE_TAG" ]] || fail "Failed to parse release tag"
  [[ -n "$DOWNLOAD_URL" ]] || fail "Failed to parse download URL"
}

download_asset() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf '$tmpdir'" EXIT

  DOWNLOADED_PATH="${tmpdir}/${ASSET_NAME}"
  log "Downloading ${ASSET_NAME} from ${RELEASE_TAG}"
  curl -fL "$DOWNLOAD_URL" -o "$DOWNLOADED_PATH"
  chmod +x "$DOWNLOADED_PATH"
}

# Windows refuses to overwrite an executable any process is running, and this
# installer is usually re-run from inside a Claude Code session, so a plain cp
# failed. A running executable can be renamed, which frees its name; see
# Install-OverRunningExe in install-patched-claude.ps1 for the measurements and
# for why the aside is not named like Anthropic's own <exe>.old.<ms>. Measured
# under Git Bash (MINGW64) against a running stand-in: cp over it failed, mv
# aside succeeded, cp into the freed name succeeded and ran, and — unlike
# PowerShell's Remove-Item — rm -f removed the aside while the old process
# still ran.
replace_windows_exe() {
  local source="$1" target="$2" old aside

  for old in "${target}".calico-old.*; do
    if [[ -e "$old" ]]; then
      rm -f "$old" 2>/dev/null || true
    fi
  done

  if [[ ! -e "$target" ]]; then
    cp "$source" "$target"
    return
  fi

  aside="${target}.calico-old.$(date +%s).$$"
  mv "$target" "$aside" || fail "Could not move the existing ${target##*/} aside to replace it."
  if ! cp "$source" "$target"; then
    mv "$aside" "$target" || fail "Could not install the patched build, and could not restore the original from ${aside}. Rename it back to ${target##*/} by hand."
    fail "Could not install the patched build. The original ${target##*/} was restored."
  fi

  rm -f "$aside" 2>/dev/null || true
  if [[ -e "$aside" ]]; then
    log "The previous ${target##*/} is still in use by a running Claude Code session; it was moved to ${aside##*/} and will be removed on a later run."
  fi
  # Git Bash can delete the aside even while it runs, so whether a session is
  # open cannot be told from here. The sentence is true either way.
  log "Any Claude Code session already open keeps running the previous build until it is restarted."
}

install_asset() {
  local target_dir target_real owner_cmd
  target_real="$(python3 - "$CLAUDE_PATH" <<'PY'
import os
import sys
target = os.path.realpath(sys.argv[1])
if os.name == "nt" and not os.path.exists(target) and os.path.exists(target + ".exe"):
    target += ".exe"
print(target)
PY
)"
  target_dir="$(dirname "$target_real")"

  if is_windows_shell && [[ ! -e "$target_real" && -e "${target_real}.exe" ]]; then
    target_real="${target_real}.exe"
    target_dir="$(dirname "$target_real")"
  fi

  if is_windows_shell; then
    if [[ -w "$target_dir" && ( ! -e "$target_real" || -w "$target_real" ) ]]; then
      replace_windows_exe "$DOWNLOADED_PATH" "$target_real"
    else
      fail "Target is not writable: ${target_real}. Re-run from an elevated shell or install manually."
    fi
    INSTALLED_PATH="$target_real"
    return
  fi

  if [[ -w "$target_dir" && ( ! -e "$target_real" || -w "$target_real" ) ]]; then
    install -m 0755 "$DOWNLOADED_PATH" "$target_real"
  else
    require_cmd sudo
    sudo install -m 0755 "$DOWNLOADED_PATH" "$target_real"
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ -w "$target_real" ]]; then
      xattr -dr com.apple.quarantine "$target_real" 2>/dev/null || true
    else
      require_cmd sudo
      sudo xattr -dr com.apple.quarantine "$target_real" 2>/dev/null || true
    fi
  fi

  INSTALLED_PATH="$target_real"
}

verify_install() {
  log "Installed patched Claude to ${INSTALLED_PATH}"
  "${INSTALLED_PATH}" --version
  warn_about_official_updater
}

# This installer writes over the binary Anthropic's updater manages. Calico
# builds carry disable-official-updater, so the installed build never runs that
# updater, in the background or through `claude update`; it stays patched and
# never upgrades itself. What can still replace it is an official build's
# updater running in some other process: a session started before the install
# keeps the old binary in memory. Observed on Windows: claude.exe went from a
# patched 2.1.278 to the official 2.1.280 within half an hour of the install,
# and the only Claude Code process running at that moment had been open since
# before it (which process made the write was not traced). Say both things at
# the moment they become true.
warn_about_official_updater() {
  cat >&2 <<'EOF'

Note: this replaced the `claude` binary that Anthropic's updater manages. Calico
builds never run that updater, so this one does not upgrade itself: re-run this
installer to upgrade. Claude Code sessions that were already open still run the
previous build, and an official build's updater can replace this one; restart
them. To have Calico update itself, install it side by side as `calico-claude`:
    https://github.com/Nanako0129/calico-claude#keeping-it-updated

EOF
}

main() {
  detect_platform
  find_existing_claude
  detect_installed_version
  fetch_release_metadata
  download_asset
  install_asset
  verify_install
}

main "$@"
