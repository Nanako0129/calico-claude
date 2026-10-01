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
var CAP=600000;
function group(e){let w=[],D={messages:[],thoughtForMs:0},W;function ve(){if(D.messages.length===0)return;w.push({row:D.messages.map((m)=>m.id)}),D={messages:[],thoughtForMs:0}}
for(let Ee of e){let Me=thinkingOf(Ee);if(Ee.kind==="tool")D.messages.push(Ee);else if(WEr(Ee)||Me!==void 0&&vPt(Me.message))ve(),w.push(Ee);else if(Me!==void 0){let Ne=Me.memo.summary??=Me.memo.thinking;if(W!==void 0){let Fe=Date.parse(Ee.timestamp)-Date.parse(W);if(Number.isFinite(Fe)&&Fe>0)D.thoughtForMs+=Math.min(Fe,CAP)}D.messages.push(Me.message)}else ve(),w.push(Ee);if("timestamp"in Ee&&typeof Ee.timestamp==="string")W=Ee.timestamp}return ve(),w.map((m)=>m.row?m:m.id)}
`;

function run(messages, { patch = true, context = {} } = {}) {
  const source = patch ? patchThinkingNotCollapsed(fixture).content : fixture;
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

test("patched: the standalone block keeps the duration the row would have counted", () => {
  const block = { type: "thinking" };
  const timed = [
    { id: "u", kind: "prompt", timestamp: "2026-10-01T00:00:00.000Z" },
    { id: "think", kind: "thinking", text: "Plan.", message: { content: [block] }, timestamp: "2026-10-01T00:00:05.200Z" },
  ];
  const context = {};
  run(timed, { context });
  assert.equal(context.__calicoThoughtMs.get(block), 5200);
});
