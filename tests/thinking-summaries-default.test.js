// Without `showThinkingSummaries` set, Claude Code requests redacted thinking
// (the redact-thinking beta, no `display`), so thinking blocks carry no text
// and nothing can be shown. This module makes the absent case behave like
// `true` while an explicit `false` still opts out.
//
// The assertions run the patched accessor and the beta gate that reads it,
// rather than matching emitted text: what matters is which value comes back
// for each setting, and `||` in place of `??` would turn an explicit false
// back on without changing how the text looks to a regex.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchThinkingSummariesDefault } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The accessor as shipped in 2.1.281, the interactive display choice that
// calls it, and the redact-beta predicate, with the settings getter stubbed.
const fixture = `
function Ye(){return settings}
function eon(){return Ye().showThinkingSummaries??!1}
function display(){return eon()?"summarized":void 0}
function redactBeta(){return !eon()}
`;

function run(setting, { patch = true } = {}) {
  const result = patch ? patchThinkingSummariesDefault(fixture) : { content: fixture };
  const context = { settings: setting === undefined ? {} : { showThinkingSummaries: setting } };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  return { display: context.display(), redact: context.redactBeta() };
}

// The control: unpatched, an unset setting asks for redacted thinking. This is
// the state users reported as "thinking never shows, not even expanded".
test("unpatched: an unset setting requests redacted thinking", () => {
  assert.deepEqual(run(undefined, { patch: false }), { display: undefined, redact: true });
});

test("patched: an unset setting requests summarized, unredacted thinking", () => {
  assert.deepEqual(run(undefined), { display: "summarized", redact: false });
});

test("patched: an explicit false still opts out", () => {
  assert.deepEqual(run(false), { display: undefined, redact: true });
});

test("patched: an explicit true is unchanged", () => {
  assert.deepEqual(run(true), { display: "summarized", redact: false });
});

test("the module patches exactly the accessor and the verifier accepts it", () => {
  const result = patchThinkingSummariesDefault(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("thinking-summaries-default", result.content), null);
});

test("the verifier rejects an unpatched accessor", () => {
  assert.notEqual(evaluatePatchModule("thinking-summaries-default", fixture), null);
});

test("a renamed accessor and settings getter still match", () => {
  const renamed = fixture.replace(/\beon\b/g, "$q1").replace(/\bYe\b/g, "Q$");
  const result = patchThinkingSummariesDefault(renamed);
  assert.equal(result.patched, 1);
  assert.ok(result.content.includes("function $q1(){return Q$().showThinkingSummaries??!0}"));
});
