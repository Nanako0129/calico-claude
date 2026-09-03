#!/usr/bin/env bash
# Dispatch watch-claude-release.yml when upstream has a version we have not
# released yet.
#
# Why this exists: GitHub's scheduler is the only in-GitHub trigger for "upstream
# published a new version and nothing happened in this repo", and it does not
# honour the cron on this repository. Measured over 2026-08-26/27 the hourly
# schedule drifted 30-50 minutes late, then skipped 2.3h, 4.3h, 10.3h and 10.7h;
# tightening it to */15 produced zero scheduled runs in the 80 minutes after it
# went live. Merges to main are covered by the workflow's `push` trigger, and
# `liskin/gh-workflow-keepalive` covers schedules GitHub disables for
# inactivity, but neither covers upstream drift. This does.
#
# It is deliberately not an unconditional poke: it resolves the current upstream
# version and dispatches only when a platform release for it is missing, so a
# machine that is awake all day produces no runs until there is actual work.
#
# Install as a LaunchAgent (hourly, plus once at load):
#
#   bash tools/watch-poke.sh --install
#   launchctl list | grep calico-watch-poke
#
# Remove:
#
#   launchctl bootout gui/$(id -u)/com.calico.watch-poke
#   rm ~/Library/LaunchAgents/com.calico.watch-poke.plist
#
# Logs to ~/Library/Logs/calico-watch-poke.log.

set -uo pipefail

REPO="${CALICO_WATCH_REPO:-Nanako0129/calico-claude}"
WORKFLOW="watch-claude-release.yml"
LABEL="com.calico.watch-poke"
PLATFORMS=(linux-x64 linux-arm64 macos-arm64 win32-x64 win32-arm64)
LOG_FILE="$HOME/Library/Logs/calico-watch-poke.log"

# launchd hands a process a near-empty PATH, so Homebrew's gh and node are not
# on it. Everything below runs through this PATH explicitly.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"
}

# `&`, `<` and `>` are all legal in a macOS path and all special in XML, so a
# checkout under e.g. ~/src/claude&co would emit a malformed plist. launchctl
# then refuses to bootstrap it and the watcher is silently never installed.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

install_agent() {
  local script_path plist_path script_xml log_xml repo_xml
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  plist_path="$HOME/Library/LaunchAgents/$LABEL.plist"
  script_xml="$(xml_escape "$script_path")"
  log_xml="$(xml_escape "$LOG_FILE")"
  # CALICO_WATCH_REPO is read at run time, and launchd starts the agent with a
  # clean environment, so a fork owner installing with
  # `CALICO_WATCH_REPO=owner/fork ... --install` would get an agent that quietly
  # checks and dispatches against the default repo instead. Bake the resolved
  # value into the plist so the installed agent targets what was configured.
  repo_xml="$(xml_escape "$REPO")"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script_xml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CALICO_WATCH_REPO</key><string>$repo_xml</string>
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$log_xml</string>
  <key>StandardErrorPath</key><string>$log_xml</string>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$plist_path" || {
    echo "failed to bootstrap $LABEL" >&2
    return 1
  }
  echo "installed $plist_path (hourly, runs once now)"
  echo "log: $LOG_FILE"
}

if [ "${1:-}" = "--install" ]; then
  install_agent
  exit $?
fi

for tool in gh npm; do
  command -v "$tool" >/dev/null 2>&1 || { log "missing $tool on PATH"; exit 1; }
done

VERSION="$(npm view @anthropic-ai/claude-code version 2>/dev/null)"
if [ -z "$VERSION" ]; then
  log "npm did not return an upstream version; skipping"
  exit 0
fi

# One listing, then match locally. `gh release view` exits non-zero for a tag
# that does not exist AND for a lookup that could not be answered — a network
# blip, a rate limit, a 5xx — and prints "release not found" either way, so
# there is nothing in it to tell the two apart. Treating both as "missing" makes
# a failed API call dispatch a five-platform rebuild. That fired at
# 2026-09-03T01:37:29Z; only the dispatch call failing too kept it from
# rebuilding, which is luck, not design.
#
# A paginated listing fails as a unit and reports why, so its exit status
# carries the distinction the per-tag check could not express.
#
# Paginated rather than a capped `--limit`, because any cap is a bet on
# position. Releases come back newest-first, and each rebuild of the current
# version adds five entries ahead of that version's base tags: twelve rebuilds
# push them past a limit of 60. The base tags would then read as missing and the
# agent would dispatch every hour until upstream moved — the same "cannot tell
# absent from unseen" mistake this commit is fixing, one layer out. Fetching all
# of them costs seconds once an hour (measured: 214 releases, 3.8s).
if ! RELEASE_TAGS="$(gh api --paginate "repos/${REPO}/releases" --jq '.[].tag_name' 2>/dev/null)"; then
  log "could not list releases for $REPO; skipping this tick"
  exit 0
fi

MISSING=0
for suffix in "${PLATFORMS[@]}"; do
  if ! printf '%s\n' "$RELEASE_TAGS" | grep -qxF "v${VERSION}-${suffix}"; then
    MISSING=1
    break
  fi
done

if [ "$MISSING" -eq 0 ]; then
  log "upstream $VERSION already released on all platforms; no dispatch"
  exit 0
fi

# Do not pile dispatches on top of a run that is already working. The workflow
# guards this too, but a queued no-op still costs a run and clutters the list.
ACTIVE="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 10 \
  --json status --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null)"
if [ -n "$ACTIVE" ] && [ "$ACTIVE" -gt 0 ]; then
  log "upstream $VERSION missing releases, but $WORKFLOW already has $ACTIVE active run(s); skipping"
  exit 0
fi

if gh workflow run "$WORKFLOW" --repo "$REPO" >/dev/null 2>&1; then
  log "dispatched $WORKFLOW for upstream $VERSION"
else
  log "failed to dispatch $WORKFLOW for upstream $VERSION"
  exit 1
fi
