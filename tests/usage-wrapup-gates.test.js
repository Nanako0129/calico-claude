const assert = require("node:assert/strict");
const test = require("node:test");

const { patchDisableUsageWrapUpHints } = require("../patch-claude-display.ts");

// Mirrors the 2.1.238 bundle shape: gate names assigned to minified vars, then
// read through the statsig getter `it(gate, default)` at the two injection
// sites (grace-window wrap-up and 95% near-limit checkpoint).
const fixture =
  'var GIS=3600000,VIS=300000,KIS,WHp,GHp="tengu_lantern_wick_mode",KHp,_3n="tengu_vellum_anchor",' +
  'YHp="[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work.]";' +
  'if(!Ne&&te&&cNp(Pe.depth===0)){let Wr=VHp(it(GHp,"off"));if(Wr!=="off"){inject(Wr==="next-steps"?KHp:WHp)}}' +
  "if(!Ne&&te&&Pe.depth>0&&uNp()){if(it(_3n,!1)){notice(JHp);inject(YHp)}}";

test("renames both usage wrap-up statsig gates to dead calico gates", () => {
  const result = patchDisableUsageWrapUpHints(fixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.ok(!result.content.includes('"tengu_lantern_wick_mode"'));
  assert.ok(!result.content.includes('"tengu_vellum_anchor"'));
  assert.ok(result.content.includes('"calico_lantern_wick_off"'));
  assert.ok(result.content.includes('"calico_vellum_gone_"'));
});

test("replacement gate names preserve byte length", () => {
  const result = patchDisableUsageWrapUpHints(fixture);
  assert.equal(result.content.length, fixture.length);
});

test("is idempotent on already-patched content", () => {
  const once = patchDisableUsageWrapUpHints(fixture);
  const twice = patchDisableUsageWrapUpHints(once.content);
  assert.equal(twice.candidates, 0);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once.content);
});

test("leaves pre-feature bundles untouched", () => {
  const oldBundle = 'var x="tengu_something_else";run(x)';
  const result = patchDisableUsageWrapUpHints(oldBundle);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
  assert.equal(result.content, oldBundle);
});
