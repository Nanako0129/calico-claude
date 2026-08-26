const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { patchThinkingStreaming } = require(
  path.join(__dirname, "..", "patch-claude-display.ts")
);

// The positional stream-reducer branch is a separate scope from the two
// destructured reducer loops. Referencing their helper there is not a syntax
// error, so it only throws the first time a bundle actually reaches this shape —
// and it aborts the entire patch run when it does. No fixture exercised this
// branch, which is how a `reducerMessageHelper` reference survived here.
function positionalReducerBundle() {
  return [
    'var VERSION="2.1.200";',
    // upstream's create-virtual-message helper, matched by its option names
    "function mkMessage({content:a,usage:b,isVirtual:c,now:d,uuid:e}){return inner({content:a,usage:b,isVirtual:c,now:d,uuid:e})}",
    // a >=7 parameter positional reducer carrying all three anchors
    "function reduce(evt,ctx,appendOutput,setMode,setStreamingTools,extra,setStreamingThinking){",
    'if(evt.type!=="stream_event"&&evt.type==="stream_request_start"){setMode("requesting");return}',
    'if(evt.type==="stream_request_start"){setMode("requesting");return}',
    'switch(evt.event.type){case"thinking":case"redacted_thinking":setMode("thinking");return;',
    'case"thinking_delta":return;}',
    "}",
    "function tail(){}",
  ].join("");
}

test("positional stream reducer branch does not reference an out-of-scope helper", () => {
  const source = positionalReducerBundle();

  // The bug this pins is a ReferenceError thrown while building the
  // replacement, which takes down the whole patch run rather than skipping one
  // module. Any outcome other than throwing is acceptable here.
  let result;
  assert.doesNotThrow(() => {
    result = patchThinkingStreaming(source);
  });
  assert.equal(typeof result.content, "string");
  assert.equal(typeof result.candidates, "number");
});

test("positional stream reducer skips its injection when no helper is in its module", () => {
  // Same bundle with the helper declaration removed: the branch must decline to
  // inject rather than emit a name it could not resolve.
  const source = positionalReducerBundle().replace(
    /function mkMessage\([^)]*\)\{[^}]*\}/,
    ""
  );
  const result = patchThinkingStreaming(source);

  assert.equal(result.content.includes("__cc_streamingThinkingMessage"), false);
});
