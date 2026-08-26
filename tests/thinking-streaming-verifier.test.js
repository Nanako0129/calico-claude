const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateDisabledPatchModule,
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const plumbing = "__cc_streamingThinking";
const briefMarker =
  'if(a?.type==="thinking"||a?.type==="redacted_thinking")return!0;if(a?.type==="tool_use"';
const rendererSignatureMarker =
  "({messages:e,streamingToolUses:a,streamingThinking:__cc_streamingThinking,";
const rendererCallSiteMarker = "screen:l,streamingToolUses:c,streamingThinking:ds,";
const storeCallSiteMarker =
  "screen:l,streamingToolUses:c,streamingThinking:__cc_streamingThinkingState,";
const inlineExtrasMarker = "__cc_streamingThinkingExtras";
// The un-rewritten memo the patch is supposed to take over.
const unpatchedExtrasMarker =
  'let extras=React.useMemo(()=>streamingToolUses.flatMap((entry)=>{let msg=createMessage({content:[entry.contentBlock]});return msg.uuid=mintUuid(entry.contentBlock.id,0),normalize([msg])}),[streamingToolUses])';

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
    /renderer signature to declare a streamingThinking parameter/
  );
  // Signature alone is not proof the renderer receives the value: the
  // broken-2.1.235 shape carries the injected signature and the inline extras
  // with no caller prop, and must fail on the call-site check.
  assert.match(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.235",
        `${briefMarker} ${rendererSignatureMarker} ${inlineExtrasMarker}`
      )
    ),
    /expected 1 renderer call-site streamingThinking prop, found 0/
  );
  // Before 2.1.246 the extras site exists, so its marker stays mandatory: a
  // missing injection there means the reducer updates state the UI never reads.
  assert.match(
    evaluatePatchModule(
      "thinking-streaming",
      bundle("2.1.234", `${briefMarker} ${rendererSignatureMarker} ${rendererCallSiteMarker}`)
    ),
    /inline streaming-thinking transcript extras/
  );
  // 2.1.246 restructured that memo away, so its absence is accepted there —
  // but only when the site is genuinely gone.
  assert.equal(
    evaluatePatchModule(
      "thinking-streaming",
      bundle("2.1.246", `${briefMarker} ${rendererSignatureMarker} ${rendererCallSiteMarker}`)
    ),
    null
  );
  assert.match(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.246",
        `${briefMarker} ${rendererSignatureMarker} ${rendererCallSiteMarker} ${unpatchedExtrasMarker}`
      )
    ),
    /transcript extras site is present but was not patched/
  );
  assert.equal(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.234",
        `${briefMarker} ${rendererSignatureMarker} ${rendererCallSiteMarker} ${inlineExtrasMarker}`
      )
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
    /renderer signature to declare a streamingThinking parameter/
  );
  // Store-snapshot threading (2.1.236+): the store destructure alone must not
  // pass — a call site passing the store local is required.
  assert.match(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.237",
        `${briefMarker} ${rendererSignatureMarker} let{streamingToolUses:Fo,streamingThinking:__cc_streamingThinkingState,userInputOnProcessing:Ui}=t3(Rr.stream) ${inlineExtrasMarker}`
      )
    ),
    /expected 1 renderer call-site streamingThinking prop, found 0/
  );
  assert.equal(
    evaluatePatchModule(
      "thinking-streaming",
      bundle(
        "2.1.237",
        `${briefMarker} ${rendererSignatureMarker} ${storeCallSiteMarker} ${inlineExtrasMarker}`
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
