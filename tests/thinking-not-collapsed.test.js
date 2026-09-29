// A finished, non-empty thinking block used to be folded into the collapsed
// read/search row, which the prompt screen draws as "Thought for Ns" only
// (issue #67). The module sends it down the standalone branch instead.
//
// The fixture is the grouping branch from 2.1.284, reduced to what decides where
// a message goes. It runs the patched code: which messages end up in a row and
// which stand alone is the behaviour, and a text match cannot show it.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchThinkingNotCollapsed } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// thinkingOf() mirrors ftr: undefined for anything that is not a thinking block
// with non-blank text. vPt is the narration predicate, and `kind: "tool"` stands
// in for the tool-use branches that feed the row.
const fixture = `
function WEr(e){return e.kind==="boundary"}
function vPt(e){return e.narration===!0}
function thinkingOf(e){if(e.kind!=="thinking"||!e.text||e.text.trim()==="")return;return{message:e,memo:{thinking:e.text}}}
function group(e){let w=[],D={messages:[]};function ve(){if(D.messages.length===0)return;w.push({row:D.messages.map((m)=>m.id)}),D={messages:[]}}
for(let Ee of e){let Me=thinkingOf(Ee);if(Ee.kind==="tool")D.messages.push(Ee);else if(WEr(Ee)||Me!==void 0&&vPt(Me.message))ve(),w.push(Ee);else if(Me!==void 0){let Ne=Me.memo.summary??=Me.memo.thinking;D.messages.push(Me.message)}else ve(),w.push(Ee)}return ve(),w.map((m)=>m.row?m:m.id)}
`;

function run(messages, { patch = true } = {}) {
  const source = patch ? patchThinkingNotCollapsed(fixture).content : fixture;
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  context.input = messages;
  return JSON.parse(JSON.stringify(vm.runInContext("group(input)", context)));
}

const turn = [
  { id: "t1", kind: "tool" },
  { id: "think", kind: "thinking", text: "Let me think about this carefully." },
  { id: "t2", kind: "tool" },
  { id: "t3", kind: "tool" },
];

test("unpatched: non-empty thinking is folded into the collapsed row", () => {
  assert.deepEqual(run(turn, { patch: false }), [{ row: ["t1", "think", "t2", "t3"] }]);
});

test("patched: non-empty thinking stands alone and tool calls still collapse", () => {
  assert.deepEqual(run(turn), [{ row: ["t1"] }, "think", { row: ["t2", "t3"] }]);
});

test("patched: blank thinking still folds as before", () => {
  const blank = [{ id: "t1", kind: "tool" }, { id: "b", kind: "thinking", text: "  " }, { id: "t2", kind: "tool" }];
  assert.deepEqual(run(blank), run(blank, { patch: false }));
});

test("the module applies once and the verifier accepts only the patched form", () => {
  const result = patchThinkingNotCollapsed(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("thinking-not-collapsed", result.content), null);
  assert.notEqual(evaluatePatchModule("thinking-not-collapsed", fixture), null);
});

test("a second matching branch leaves the bundle untouched", () => {
  const doubled = fixture + fixture.replace("function group(", "function group2(");
  const result = patchThinkingNotCollapsed(doubled);
  assert.equal(result.patched, 0);
  assert.equal(result.content, doubled);
});
