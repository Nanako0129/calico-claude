#!/usr/bin/env bash
# Run a patched (or unpatched) Claude binary against a canned streaming response
# and report what the TUI actually rendered. Needs no credentials and no
# network.
#
#   bash tools/local-verify/run.sh <claude-binary> [port]
#
# Three defects in the 2.1.242 chunk-split work produced bundles where every
# text-level check passed and the feature was dead or the whole turn was empty.
# Static checks cannot see a wrong-but-valid call; this can.
set -uo pipefail

BINARY="${1:-}"
PORT="${2:-8787}"
if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  echo "usage: bash tools/local-verify/run.sh <claude-binary> [port]" >&2
  exit 2
fi
for cmd in node expect perl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required command: $cmd" >&2; exit 2; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
CONFIG="$WORK/config"
mkdir -p "$CONFIG"
trap 'kill "${MOCK_PID:-}" 2>/dev/null; rm -rf "$WORK"' EXIT

# Seed onboarding, folder trust and API-key approval. Without all three the TUI
# stops before the main renderer mounts and nothing downstream is exercised —
# which is exactly why the CI PTY smoke test missed a startup crash.
node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    hasCompletedOnboarding: true,
    theme: "dark",
    numStartups: 9,
    installMethod: "native",
    // Suppress the first-launch "What'"'"'s new" panel: it shifts the layout and
    // races the input box into existence.
    lastReleaseNotesSeen: "99.0.0",
    customApiKeyResponses: { approved: ["sk-ant-mock"], rejected: [] },
    primaryApiKey: "sk-ant-mock",
    projects: {
      [process.argv[2]]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        allowedTools: [],
        history: [],
      },
    },
  }));
' "$CONFIG/.claude.json" "$PWD"

node "$HERE/mockapi.js" "$PORT" >/dev/null 2>"$WORK/mock.err" &
MOCK_PID=$!
for _ in $(seq 1 40); do
  grep -q "mock listening" "$WORK/mock.err" 2>/dev/null && break
  sleep 0.25
done
grep -q "mock listening" "$WORK/mock.err" 2>/dev/null || {
  echo "mock API failed to start:" >&2; cat "$WORK/mock.err" >&2; exit 1; }

expect "$HERE/tui.exp" "$BINARY" "$WORK/tui.raw" "$CONFIG" "http://127.0.0.1:$PORT" >/dev/null 2>&1
STATUS=$?

LC_ALL=C perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a]*(?:\a|\e\\)//g; s/\e[()][A-Za-z0-9]//g' \
  "$WORK/tui.raw" 2>/dev/null | LC_ALL=C tr -cd '\11\12\15\40-\176' > "$WORK/tui.clean"

echo "binary        : $BINARY"
grep -q "REQUEST" "$WORK/mock.err" \
  && echo "request       : SENT ($(grep -c REQUEST "$WORK/mock.err"))" \
  || echo "request       : NEVER SENT  <-- the turn died before reaching the API"
grep -aq "pongfromthemock" "$WORK/tui.clean" \
  && echo "assistant text: RENDERED" \
  || echo "assistant text: MISSING  <-- the stream arrived but nothing was rendered"
ERR="$(LC_ALL=C grep -aoE "[A-Za-z_.$]*(is not defined|is not a function)" "$WORK/tui.clean" | head -2)"
[ -n "$ERR" ] && echo "errors        : $ERR" || echo "errors        : none"
[ "$STATUS" -ne 0 ] && echo "harness       : expect exited $STATUS (see above)"

grep -aq "pongfromthemock" "$WORK/tui.clean"
