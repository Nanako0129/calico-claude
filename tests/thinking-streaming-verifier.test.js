const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateDisabledPatchModule,
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const plumbing = "__cc_streamingThinking";
const briefMarker =
  'if(a?.type==="thinking"||a?.type==="redacted_thinking")return!0;if(a?.type==="tool_use"';

function bundle(version, extra = "") {
  return `PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"${version}" ${plumbing} ${extra}`;
}

test("thinking verifier skips the brief filter before Claude 2.1.216", () => {
  assert.equal(evaluatePatchModule("thinking-streaming", bundle("2.1.215")), null);
});

test("thinking verifier requires the brief filter from Claude 2.1.216", () => {
  assert.match(
    evaluatePatchModule("thinking-streaming", bundle("2.1.216")),
    /brief filter/
  );
  assert.equal(
    evaluatePatchModule("thinking-streaming", bundle("2.1.216", briefMarker)),
    null
  );
});

test("thinking verifier rejects unparseable Claude version metadata", () => {
  assert.match(
    evaluatePatchModule("thinking-streaming", plumbing),
    /VERSION metadata/
  );
});

test("disabled thinking verifier rejects installed streaming plumbing", () => {
  assert.match(
    evaluateDisabledPatchModule("thinking-streaming", plumbing),
    /unexpectedly present/
  );
  assert.equal(evaluateDisabledPatchModule("thinking-streaming", ""), null);
});
