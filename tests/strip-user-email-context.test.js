// The user context hands the model the signed-in account's address, and the
// model has sent it out as a client's contact details (anthropics/claude-code
// #107757). strip-user-email-context keeps the address out of the context
// unless CALICO_KEEP_USER_EMAIL=1. These tests run the patched context builder.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchStripUserEmailContext } = require("../patch-claude-display.ts");
const { evaluatePatchModule, evaluateDisabledPatchModule } = require("../scripts/verify-patched-binary.ts");

// The 2.1.319 shape, reduced to the context object.
const fixture =
  'function buildContext(H,y){let Te={claudeMd:y??"",...H&&{userEmail:`The user\'s email address is ${H}. Use it only to identify the user, such as for authorship, attribution, or filtering their own work.`},currentDate:"2026-11-06"};return Te}';

function run(source, env) {
  const context = { process: { env } };
  vm.createContext(context);
  vm.runInContext(source, context);
  return vm.runInContext('buildContext("someone@example.com","rules")', context);
}

test("unpatched control: the address reaches the context", () => {
  const ctx = run(fixture, {});
  assert.match(ctx.userEmail, /someone@example\.com/);
  assert.notEqual(evaluatePatchModule("strip-user-email-context", fixture), null);
});

test("patched: the address is left out by default", () => {
  const result = patchStripUserEmailContext(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  const ctx = run(result.content, {});
  assert.equal("userEmail" in ctx, false);
  assert.equal(JSON.stringify(ctx).includes("someone@example.com"), false);
  // The rest of the context is untouched.
  assert.equal(ctx.claudeMd, "rules");
  assert.equal(ctx.currentDate, "2026-11-06");
  assert.equal(evaluatePatchModule("strip-user-email-context", result.content), null);
});

test("CALICO_KEEP_USER_EMAIL=1 restores the upstream block", () => {
  const { content } = patchStripUserEmailContext(fixture);
  const kept = run(content, { CALICO_KEEP_USER_EMAIL: "1" });
  assert.match(kept.userEmail, /someone@example\.com/);
  // Any other value keeps it out.
  for (const value of ["0", "true", ""]) {
    assert.equal("userEmail" in run(content, { CALICO_KEEP_USER_EMAIL: value }), false, value);
  }
});

test("no signed-in address: nothing is added either way", () => {
  const { content } = patchStripUserEmailContext(fixture);
  const context = { process: { env: { CALICO_KEEP_USER_EMAIL: "1" } } };
  vm.createContext(context);
  vm.runInContext(content, context);
  assert.equal("userEmail" in vm.runInContext('buildContext(void 0,"")', context), false);
});

test("idempotent: a second run finds nothing and changes nothing", () => {
  const once = patchStripUserEmailContext(fixture).content;
  const twice = patchStripUserEmailContext(once);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once);
  assert.equal(evaluatePatchModule("strip-user-email-context", once), null);
});

test("zero or two sites patch nothing", () => {
  const none = fixture.replace("userEmail:", "accountEmail:");
  assert.equal(patchStripUserEmailContext(none).patched, 0);
  const two = `${fixture}\n${fixture.replace("buildContext", "buildContext2")}`;
  const result = patchStripUserEmailContext(two);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 0);
  assert.equal(result.content, two);
});

test("verifier rejects a second, ungated block", () => {
  const patched = patchStripUserEmailContext(fixture).content;
  const leaky = `${patched}\n${fixture.replace("buildContext", "buildContext2")}`;
  assert.notEqual(evaluatePatchModule("strip-user-email-context", leaky), null);
});

test("disabled: the verifier accepts the stock block", () => {
  assert.equal(evaluateDisabledPatchModule("strip-user-email-context", fixture), null);
});
