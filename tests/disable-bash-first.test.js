// Upstream's `thrifty_sonic` experiment injects a synthetic `isMeta` turn in
// auto and bypassPermissions mode telling the model to make file changes with
// `sed` and heredocs "rather than using the dedicated Read, Edit, or Write
// tools". This module makes the gate default off while leaving
// CLAUDE_CODE_THRIFTY_SONIC working in both directions.
//
// The assertions run the patched gate rather than matching its text: the whole
// point is which of three values it returns for which env input, and a regex
// on the emitted source cannot see that `??` was written where `||` would have
// turned an explicit `false` back into the cohort default.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchDisableBashFirst } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The gate as shipped, with the surrounding helpers reduced to stubs. `a` is
// the parsed-env accessor: its CLAUDE_CODE_THRIFTY_SONIC entry is declared
// `I.triBool()` upstream, so it yields true, false or undefined — never a raw
// string. Reproduced here as a plain property for the same reason.
const fixture = (assignment) => `
function Zd(){return ${JSON.stringify(assignment)}}
function H(){return true}
var ka="tengu_thrifty_sonic";
function gate(){if(a.CLAUDE_CODE_THRIFTY_SONIC!==void 0)return a.CLAUDE_CODE_THRIFTY_SONIC;switch(Zd()){case"forced":return!0;case"none":return!1;case"cohort":return H(ka,!1)}}
`;

function gateUnder(assignment, envValue, { patch = true } = {}) {
  const source = fixture(assignment);
  const result = patch ? patchDisableBashFirst(source) : { content: source };
  const context = { a: envValue === undefined ? {} : { CLAUDE_CODE_THRIFTY_SONIC: envValue } };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  return context.gate();
}

// The control. Without the patch, a server-side "forced" assignment or a
// cohort hit turns the steer on with no env var involved — that is the state
// this module exists to change, and asserting it here is what proves the
// patched expectations below are measuring the patch.
test("unpatched, the server-side assignment decides", () => {
  assert.equal(gateUnder("forced", undefined, { patch: false }), true);
  assert.equal(gateUnder("cohort", undefined, { patch: false }), true);
  assert.equal(gateUnder("none", undefined, { patch: false }), false);
});

test("patched, an absent env var defaults the steer off", () => {
  for (const assignment of ["forced", "cohort", "none"]) {
    assert.equal(gateUnder(assignment, undefined), false, assignment);
  }
});

// The env var has to keep working in both directions. `||` instead of `??`
// would pass the off case and silently break nothing visible, since the
// default is off anyway — but it would also discard an explicit false, which
// is the same value, so only the opt-in direction distinguishes them.
test("patched, the env var still decides in both directions", () => {
  for (const assignment of ["forced", "cohort", "none"]) {
    assert.equal(gateUnder(assignment, true), true, `${assignment} + on`);
    assert.equal(gateUnder(assignment, false), false, `${assignment} + off`);
  }
});

test("reports one candidate and satisfies the verifier", () => {
  const result = patchDisableBashFirst(fixture("cohort"));
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("disable-bash-first", result.content), null);
});

test("is idempotent on already-patched content", () => {
  const once = patchDisableBashFirst(fixture("cohort"));
  const twice = patchDisableBashFirst(once.content);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once.content);
});

// A bundle that moved the gate must fail the build rather than ship one where
// the steer is quietly back, so zero candidates is the wanted outcome.
test("leaves a bundle without the gate untouched", () => {
  const moved = 'function gate(){switch(Zd()){case"forced":return!0;default:return!1}}';
  const result = patchDisableBashFirst(moved);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
  assert.equal(result.content, moved);
});

// The verifier must not accept a bundle where one copy of the gate was
// rewritten and another survived.
test("verifier rejects a surviving unpatched gate", () => {
  const patchedOnce = patchDisableBashFirst(fixture("cohort")).content;
  const withSurvivor = `${patchedOnce}\n${fixture("forced")}`;
  assert.equal(
    evaluatePatchModule("disable-bash-first", withSurvivor),
    "an unpatched CLAUDE_CODE_THRIFTY_SONIC early return is still present"
  );
});
