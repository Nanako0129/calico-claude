// With Remote Control on, a claude.ai usage limit used to do nothing: the
// `/rate-limit-options` menu did not open and automatic continue did not arm,
// because every usage-limit site shares a predicate that includes the Remote Control
// bridge. The module makes only those three sites skip the bridge term.
//
// The assertions run the patched code: what matters is which callers still see
// the bridge, and a text match cannot tell a site that skips it from one that
// only looks like it does.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchUsageLimitUnderRemoteControl } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The shipped shapes from 2.1.282, reduced to the gates. `state` stands in for
// the host: whether the bridge is up, whether this is a background session or
// a teammate agent, and whether auto-continue is already armed.
const fixture = `
function n(){return host}
function xl(){return n().surfaceCapabilities.replBridgeActive()}
function vt(){return state.background}
function NT(){return state.teammate}
function em(){return xl()||vt()||NT()!==void 0}
function sor(){return state.armed}
function U(e){return true}function z3t(){return true}function gt(){return true}function _bt(){return true}
class Surface{_autoOpenedRateLimitKeys=new Set;opened=[];_requireHost(){return{onSubmit:(c)=>{this.opened.push(c);return Promise.resolve()}}}
armRateLimitAutoContinue=(h)=>{if(h===this._autoContinueResetsAt)return!1;if(em())return!1;if(sor())return!1;this._autoContinueResetsAt=h;return!0};
openRateLimitOptions=()=>{let h=state.resetsAt??"no-reset";if(this._autoOpenedRateLimitKeys.has(h))return!1;if(sor())return this._autoOpenedRateLimitKeys.add(h),!1;if(em())return!1;let{onSubmit:v}=this._requireHost();return this._autoOpenedRateLimitKeys.add(h),v("/rate-limit-options"),!0}}
function arm(e,t){let n=t;if(!U(n)||!z3t())return!1;if(em())return!1;let s=e.resetsAt??0;return!0}
function request(e){if(e===void 0||!gt()||!_bt()||!z3t()||em())return{outcome:"declined",failureNote:void 0};return{outcome:"accepted"}}
function unrelatedDialog(){return em()}
`;

function run({ bridge = false, background = false, teammate = undefined } = {}, { patch = true } = {}) {
  const source = patch ? patchUsageLimitUnderRemoteControl(fixture).content : fixture;
  const context = {
    host: { surfaceCapabilities: { replBridgeActive: () => bridge } },
    state: { background, teammate, armed: false, resetsAt: 1790000000 },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.surface=new Surface();`, context);
  return {
    opened: context.surface.openRateLimitOptions(),
    uiArmed: context.surface.armRateLimitAutoContinue(1790000000),
    armed: vm.runInContext("arm({resetsAt:1790000000},{})", context),
    request: vm.runInContext("request({})", context).outcome,
    unrelatedSuppressed: vm.runInContext("unrelatedDialog()", context),
  };
}

// The control: unpatched, Remote Control silences all three usage-limit sites.
test("unpatched: Remote Control suppresses the menu and automatic continue", () => {
  assert.deepEqual(run({ bridge: true }, { patch: false }), {
    opened: false,
    uiArmed: false,
    armed: false,
    request: "declined",
    unrelatedSuppressed: true,
  });
});

test("patched: Remote Control no longer suppresses the four usage-limit sites", () => {
  assert.deepEqual(run({ bridge: true }), {
    opened: true,
    uiArmed: true,
    armed: true,
    request: "accepted",
    unrelatedSuppressed: true,
  });
});

test("patched: other callers of the predicate still see the bridge", () => {
  assert.equal(run({ bridge: true }).unrelatedSuppressed, true);
  assert.equal(run({ bridge: false }).unrelatedSuppressed, false);
});

test("patched: background sessions and teammate agents stay suppressed", () => {
  for (const state of [{ background: true }, { teammate: "agent-1" }, { bridge: true, background: true }]) {
    assert.deepEqual(
      { ...run(state), unrelatedSuppressed: undefined },
      { opened: false, uiArmed: false, armed: false, request: "declined", unrelatedSuppressed: undefined },
      JSON.stringify(state)
    );
  }
});

test("patched: without Remote Control nothing changes", () => {
  assert.deepEqual(run({}), run({}, { patch: false }));
});

test("the module applies all five edits and the verifier accepts them", () => {
  const result = patchUsageLimitUnderRemoteControl(fixture);
  assert.equal(result.candidates, 5);
  assert.equal(result.patched, 5);
  assert.equal(evaluatePatchModule("usage-limit-under-remote-control", result.content), null);
  assert.notEqual(evaluatePatchModule("usage-limit-under-remote-control", fixture), null);
});

// All or nothing: a menu that opens and offers the wait while arming still
// refuses it would be worse than the current silence.
test("a missing site leaves every site untouched", () => {
  const withoutArm = fixture.replace("if(em())return!1;let s=e.resetsAt??0;", "let s=e.resetsAt??0;");
  assert.notEqual(withoutArm, fixture);
  const result = patchUsageLimitUnderRemoteControl(withoutArm);
  assert.equal(result.patched, 0);
  assert.equal(result.content, withoutArm);
});

test("a site reaching the predicate under another name fails closed", () => {
  const aliased = fixture
    .replace("function em(){", "function em(){")
    .replace("||!z3t()||em())return{outcome", "||!z3t()||other())return{outcome")
    .concat("\nfunction other(){return em()}");
  const result = patchUsageLimitUnderRemoteControl(aliased);
  assert.equal(result.patched, 0);
});

test("a predicate whose first term is not the bridge is not touched", () => {
  const notBridge = fixture.replace(
    "function xl(){return n().surfaceCapabilities.replBridgeActive()}",
    "function xl(){return n().surfaceCapabilities.somethingElse()}"
  );
  assert.equal(patchUsageLimitUnderRemoteControl(notBridge).patched, 0);
});
