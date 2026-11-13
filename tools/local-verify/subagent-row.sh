#!/usr/bin/env bash
# Observe the subagent-statusline module end to end: a canned turn launches a
# background agent, and a fake subagentStatusLine command decorates its
# agent-panel row. No credentials, no network, and a throwaway config
# directory (never the real ~/.claude).
#
#   bash tools/local-verify/subagent-row.sh <claude-binary> [expect-decorated|expect-default]
#
# expect-decorated (the default) passes when the row shows the command's text
# and the command got the documented stdin; expect-default passes when the row
# stays undecorated (an unpatched 2.1.323, the control).
set -uo pipefail

BINARY="${1:-}"
MODE="${2:-expect-decorated}"
if [ -z "$BINARY" ] || [ ! -x "$BINARY" ]; then
  echo "usage: bash tools/local-verify/subagent-row.sh <claude-binary> [expect-decorated|expect-default]" >&2
  exit 2
fi
for cmd in node expect perl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing required command: $cmd" >&2; exit 2; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
CONFIG="$WORK/config"
PROJECT="$WORK/project"
mkdir -p "$CONFIG" "$PROJECT" "$WORK/home"
# Trust is keyed on the resolved path (/var/folders is /private/var/folders).
PROJECT="$(cd "$PROJECT" && pwd -P)"
trap 'kill "${MOCK_PID:-}" 2>/dev/null; rm -rf "$WORK"' EXIT

# The two status-line commands. The subagent one keeps the last stdin it got
# and prints one decorated row per task.
cat > "$WORK/main-sl.sh" <<'SH'
#!/bin/sh
cat >/dev/null
echo MAIN-BAR
SH
cat > "$WORK/sub-sl.js" <<'JS'
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.argv[2], input);
for (const task of JSON.parse(input).tasks) {
  process.stdout.write(JSON.stringify({ id: task.id, content: `\u001b[35mCALICO-SL-ROW ${task.description}\u001b[0m` }) + "\n");
}
JS
chmod +x "$WORK/main-sl.sh"

node -e '
  const fs = require("node:fs");
  const [config, project, work, node] = process.argv.slice(1);
  fs.writeFileSync(config + "/.claude.json", JSON.stringify({
    hasCompletedOnboarding: true, theme: "dark", numStartups: 9, installMethod: "native",
    lastReleaseNotesSeen: "99.0.0",
    customApiKeyResponses: { approved: ["sk-ant-mock"], rejected: [] }, primaryApiKey: "sk-ant-mock",
    projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], history: [] } },
  }));
  fs.writeFileSync(config + "/settings.json", JSON.stringify({
    // Keep the Agent call out of auto mode: its classifier request would reach
    // the mock, which answers every streamed request with this scenario.
    permissions: { defaultMode: "default", allow: ["Agent"] },
    statusLine: { type: "command", command: work + "/main-sl.sh" },
    subagentStatusLine: { type: "command", command: JSON.stringify(node) + " " + JSON.stringify(work + "/sub-sl.js") + " " + JSON.stringify(work + "/stdin.json") },
  }));
' "$CONFIG" "$PROJECT" "$WORK" "$(command -v node)"

MOCK_SCENARIO=agent node "$HERE/mockapi.js" 0 >/dev/null 2>"$WORK/mock.err" &
MOCK_PID=$!
for _ in $(seq 1 40); do
  grep -q "mock listening" "$WORK/mock.err" 2>/dev/null && break
  sleep 0.25
done
PORT="$(sed -n 's/.*mock listening on \([0-9][0-9]*\).*/\1/p' "$WORK/mock.err" | head -1)"
[ -n "$PORT" ] || { echo "HARNESS PROBLEM (not the binary): mock API failed to start" >&2; cat "$WORK/mock.err" >&2; exit 1; }

BINARY_ABS="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"
(cd "$PROJECT" && expect "$HERE/subagent-row.exp" "$BINARY_ABS" "$WORK/tui.raw" "$CONFIG" "http://127.0.0.1:$PORT" "$WORK/home" >/dev/null 2>&1)
STATUS=$?

LC_ALL=C perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a]*(?:\a|\e\\)//g; s/\e[()][A-Za-z0-9]//g' \
  "$WORK/tui.raw" 2>/dev/null | LC_ALL=C tr -cd '\11\12\15\40-\176' > "$WORK/tui.clean"

# SUBAGENT_ROW_KEEP=<dir> keeps the cleaned TUI log and the mock log there.
if [ -n "${SUBAGENT_ROW_KEEP:-}" ]; then
  mkdir -p "$SUBAGENT_ROW_KEEP" && cp "$WORK/tui.clean" "$WORK/mock.err" "$SUBAGENT_ROW_KEEP/" 2>/dev/null
fi

AGENT_REQUESTS="$(grep -c AGENT_REQUEST "$WORK/mock.err" 2>/dev/null)"
echo "binary        : $BINARY"
echo "agent launched: $([ "${AGENT_REQUESTS:-0}" -gt 0 ] && echo "YES ($AGENT_REQUESTS request)" || echo "NO  <-- the Agent tool call never started a subagent")"
grep -aq "MAIN-BAR" "$WORK/tui.clean" && echo "main bar      : RENDERED" || echo "main bar      : MISSING"
ERR="$(LC_ALL=C grep -aoE "([A-Za-z_.$]*(is not defined|is not a function)|(Type|Reference|Range|Syntax)Error[^|]{0,60}|Cannot read propert[^|]{0,50}|Rendered (fewer|more) hooks[^|]{0,40})" "$WORK/tui.clean" | head -2)"
[ -n "$ERR" ] && echo "errors        : $ERR" || echo "errors        : none"

DECORATED=0
grep -aq "CALICO-SL-ROW Calico row probe" "$WORK/tui.clean" && DECORATED=1
DEFAULT_ROW=0
grep -aq "Calico row probe" "$WORK/tui.clean" && DEFAULT_ROW=1
if [ "$DECORATED" -eq 1 ]; then
  echo "agent row     : DECORATED by subagentStatusLine"
elif [ "$DEFAULT_ROW" -eq 1 ]; then
  echo "agent row     : DEFAULT look"
else
  echo "agent row     : NOT SEEN"
fi

FIELDS_OK=0
if [ -f "$WORK/stdin.json" ]; then
  node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const top = ["session_id", "transcript_path", "cwd", "model", "context_window", "columns", "tasks"];
    const task = ["id", "type", "status", "description", "label", "startTime", "tokenCount", "tokenSamples", "cwd"];
    const missingTop = top.filter((k) => !(k in s));
    const t = s.tasks?.[0] ?? {};
    const missingTask = task.filter((k) => !(k in t));
    console.log("stdin fields  : " + (missingTop.length + missingTask.length === 0 ? "OK" : "MISSING " + [...missingTop, ...missingTask.map((k) => "tasks[]." + k)].join(", ")));
    console.log("stdin sample  : " + JSON.stringify({ session_id: s.session_id, columns: s.columns, task: { id: t.id, type: t.type, status: t.status, description: t.description, agentType: t.agentType, model: t.model, contextWindowSize: t.contextWindowSize, tokenCount: t.tokenCount } }));
    process.exit(missingTop.length + missingTask.length === 0 ? 0 : 1);
  ' "$WORK/stdin.json" && FIELDS_OK=1
else
  echo "stdin fields  : the subagentStatusLine command never ran"
fi

[ -z "$ERR" ] || exit 1
[ "${AGENT_REQUESTS:-0}" -gt 0 ] || exit 1
if [ "$MODE" = "expect-default" ]; then
  [ "$DECORATED" -eq 0 ] && [ "$DEFAULT_ROW" -eq 1 ] && [ ! -f "$WORK/stdin.json" ] || exit 1
  exit 0
fi
[ "$STATUS" -eq 0 ] || { echo "harness       : expect exited $STATUS" >&2; exit 1; }
[ "$DECORATED" -eq 1 ] && [ "$FIELDS_OK" -eq 1 ] || exit 1
