const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateDisabledPatchModule,
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const plumbing = "__cc_streamingThinking";
const briefMarker =
  'if(a?.type==="thinking"||a?.type==="redacted_thinking")return!0;if(a?.type==="tool_use"';
const rendererThreadingMarker = "streamingThinking:__cc_streamingThinking,";
const inlineExtrasMarker = "__cc_streamingThinkingExtras";

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

test("thinking verifier requires renderer threading and inline extras from Claude 2.1.234", () => {
  assert.match(
    evaluatePatchModule("thinking-streaming", bundle("2.1.234", briefMarker)),
    /renderer-side streamingThinking threading/
  );
  assert.match(
    evaluatePatchModule(
      "thinking-streaming",
      bundle("2.1.234", `${briefMarker} ${rendererThreadingMarker}`)
    ),
    /inline streaming-thinking transcript extras/
  );
  assert.equal(
    evaluatePatchModule(
      "thinking-streaming",
      bundle("2.1.234", `${briefMarker} ${rendererThreadingMarker} ${inlineExtrasMarker}`)
    ),
    null
  );
  // The reducer-side __cc_streamingThinkingMessage plumbing alone must not
  // satisfy the renderer threading requirement (substring coincidence).
  assert.match(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.237",
        `${briefMarker} __cc_streamingThinkingMessage ${inlineExtrasMarker}`
      )
    ),
    /renderer-side streamingThinking threading/
  );
  // Store-snapshot threading (2.1.236+) satisfies the same requirement.
  assert.equal(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.237",
        `${briefMarker} streamingThinking:__cc_streamingThinkingState ${inlineExtrasMarker}`
      )
    ),
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
