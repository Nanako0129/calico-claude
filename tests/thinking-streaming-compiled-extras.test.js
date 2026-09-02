// 2.1.257 ran the inline streaming-thinking extras memo through the React
// Compiler. The mapper moved into one cache slot and the `flatMap` into
// another, so the `memo(()=>list.flatMap(fn),[deps])` call the patcher rewrote
// no longer exists in any form. Neither hand-written pattern matched, the
// module's count fell from 13 to 12, and --assert-all only fails at zero — so
// 2.1.257 and 2.1.258 shipped with live thinking dead. The verifier waived it
// too: its unpatched-site regex was pinned to the 2.1.245 spelling, so a site
// that was present and unpatched read as a site that no longer exists.
const assert = require("node:assert/strict");
const test = require("node:test");

const { patchThinkingStreaming } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The shape as it appears in 2.1.257, minified names and all.
const compiledExtrasSite =
  "let aT=fUt,bUt;if(Sl[31]!==aT||Sl[32]!==rQe){let CJ;if(Sl[34]!==aT)CJ=(aQe)=>{" +
  "let{id:lQe,minted:kUt}=aT(aQe);" +
  "let wUt=fu({content:[kUt?{...aQe.contentBlock,id:lQe}:aQe.contentBlock]});" +
  "return wUt.uuid=kUt?lQe:AEe(lQe,0),cm([wUt])}," +
  "Sl[34]=aT,Sl[35]=CJ;else CJ=Sl[35];" +
  "bUt=rQe.flatMap(CJ);" +
  "Sl[31]=aT,Sl[32]=rQe,Sl[33]=bUt}else bUt=Sl[33];let cQe=bUt,";

// patchThinkingStreaming only reaches the inline-extras section once it has
// resolved the transcript's streamingThinking local, which it reads off the
// renderer signature it injected earlier in the same pass.
const rendererSignature =
  "streamingToolUses:x1,extra:1,streamingThinking:__cc_streamingThinking,streamingText:";

test("the compiled 2.1.257 extras site is rewritten to merge streaming thinking", () => {
  const result = patchThinkingStreaming(rendererSignature + compiledExtrasSite);

  assert.ok(
    result.content.includes("__cc_streamingThinkingExtras"),
    "expected the merged extras construction to be injected"
  );
  // The merge has to be keyed on the thinking store, or the transcript keeps
  // serving the cached tool-use-only list while thinking streams in.
  assert.match(result.content, /__cc_streamingThinking\?\.messages\?\?\[\]/);
  // The compiler keyed the outer slot on the tool-use list and the resolver
  // only. Without forcing it, the rewritten body never runs.
  assert.ok(
    result.content.includes("if(!0||Sl[31]!==aT||Sl[32]!==rQe)"),
    "expected the owning memo guard to be forced"
  );
  // The mapper's own memo slot must survive untouched: rebuilding it per render
  // would give every tool-use entry a fresh identity downstream.
  assert.ok(
    result.content.includes("if(Sl[34]!==aT)CJ=(aQe)=>{"),
    "expected the inner mapper memo to be left intact"
  );
  assert.ok(result.content.includes("Sl[33]=bUt}else bUt=Sl[33];"));

  const output = patchThinkingStreaming(rendererSignature + compiledExtrasSite).content;
  assert.ok(!output.includes("bUt=rQe.flatMap(CJ);"), "expected the bare flatMap to be replaced");
});

test("the verifier rejects a compiled extras site left unpatched", () => {
  // Everything else the module wants is present and correct; only the extras
  // site is unpatched. This is the exact binary that shipped as 2.1.257.
  const bundle =
    'PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"2.1.257" __cc_streamingThinking ' +
    'if(a?.type==="thinking"||a?.type==="redacted_thinking")return!0;if(a?.type==="tool_use" ' +
    "({messages:e,streamingToolUses:a,streamingThinking:__cc_streamingThinking, " +
    "screen:l,streamingToolUses:c,streamingThinking:ds, " +
    compiledExtrasSite;

  assert.match(
    evaluatePatchModule("thinking-streaming", bundle),
    /transcript extras site is present but was not patched/
  );
});
