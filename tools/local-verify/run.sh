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
# Default to 0 so the OS picks a free port. A fixed port made back-to-back runs
# fail with EADDRINUSE when the previous mock had not released the socket yet,
# and the summary reports that as a harness failure indistinguishable at a
# glance from a broken binary.
PORT="${2:-0}"
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
  echo "HARNESS PROBLEM (not the binary): mock API failed to start" >&2
  cat "$WORK/mock.err" >&2; exit 1; }
# With PORT=0 the chosen port is only known once the mock is listening.
PORT="$(sed -n 's/.*mock listening on \([0-9][0-9]*\).*/\1/p' "$WORK/mock.err" | head -1)"
[ -n "$PORT" ] || { echo "HARNESS PROBLEM (not the binary): could not read the mock port" >&2; exit 1; }

expect "$HERE/tui.exp" "$BINARY" "$WORK/tui.raw" "$CONFIG" "http://127.0.0.1:$PORT" >/dev/null 2>&1
STATUS=$?

LC_ALL=C perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a]*(?:\a|\e\\)//g; s/\e[()][A-Za-z0-9]//g' \
  "$WORK/tui.raw" 2>/dev/null | LC_ALL=C tr -cd '\11\12\15\40-\176' > "$WORK/tui.clean"

# The scripted turn makes exactly this many requests. Asserting the count, not
# merely that one arrived, is what separates a healthy build from a broken
# commit path: a clone loop walking the terminal array leaves the turn unable to
# continue, and the run stops after the first request. Built deliberately from
# 2.1.260 to check that, the aliased binary reported SENT (1) against SENT (2)
# for the healthy one, while every other line — rendered text, no errors — was
# identical. "At least one request" would have passed it.
EXPECTED_REQUESTS=2
REQUEST_COUNT="$(grep -c REQUEST "$WORK/mock.err" 2>/dev/null || echo 0)"

echo "binary        : $BINARY"
if [ "$REQUEST_COUNT" -gt 0 ]; then
  echo "request       : SENT ($REQUEST_COUNT)"
else
  echo "request       : NEVER SENT  <-- the turn died before reaching the API"
fi
grep -aq "pongfromthemock" "$WORK/tui.clean" \
  && echo "assistant text: RENDERED" \
  || echo "assistant text: MISSING  <-- the stream arrived but nothing was rendered"
# Two phrases used to be the whole error vocabulary, which covered a missing
# binding and a bad callee and nothing else. The failure this harness exists to
# catch does not speak either of them: a clone loop walking the terminal array
# destructures a wrapper that has no `src`/`dst` and throws "Cannot read
# properties of undefined (reading 'message')". Worse, the mock renders
# pongfromthemock before that delta arrives, so the two lines above still report
# SENT and RENDERED — the run looks clean while the commit path is broken.
# Match the thrown-error shapes instead of two of their wordings.
ERR="$(LC_ALL=C grep -aoE "([A-Za-z_.$]*(is not defined|is not a function)|(Type|Reference|Range|Syntax)Error[^|]{0,60}|Cannot read propert[^|]{0,50}|undefined is not an? [a-z]+)" "$WORK/tui.clean" | head -2)"
[ -n "$ERR" ] && echo "errors        : $ERR" || echo "errors        : none"
[ "$STATUS" -ne 0 ] && echo "harness       : expect exited $STATUS (see above)"

# Exit non-zero on a reported error too. It used to be printed and dropped, so
# a caller that trusted the exit status saw a pass; the CI step then had to
# re-grep the human-readable summary to notice. Both now agree.
[ -z "$ERR" ] || exit 1
if [ "$REQUEST_COUNT" -ne "$EXPECTED_REQUESTS" ]; then
  echo "turn          : INCOMPLETE  <-- expected $EXPECTED_REQUESTS requests, saw $REQUEST_COUNT" >&2
  exit 1
fi

grep -aq "pongfromthemock" "$WORK/tui.clean"
