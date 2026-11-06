// Fullscreen scrolling changes `onScreen` in the props of the transcript rows at
// the viewport's edges. The engine keys its plugin render cache on a hash of the
// whole props object, so every wheel step missed the cache and re-ran every
// plugin's `ui.render` hook for a message whose content had not changed. Under
// CALICO_STABLE_ONSCREEN=1 the key keeps only whether onScreen is null (drawn
// outside the viewport) and drops the row range; without it the key must be
// exactly the stock one.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchPluginRenderStableOnScreen } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The 2.1.318 shape: a props hash memoized on the object's identity, then the
// value key joining viewport columns, isFullscreen and that hash.
const hasher =
  "function Eos(){let e=new WeakMap;return(n)=>{let r=e.get(n);if(r!==void 0)return r;hashed.push(n);let s=JSON.stringify(n);return e.set(n,s),s}}var kos=Eos();";
const stockKey = 'var Vpr=(e)=>[e.viewport?.columns??"",e.viewport?.isFullscreen??"",kos(e.props)].join("\\x00");';
const fixture = `var meta={VERSION:"2.1.318"};${hasher}${stockKey}`;

function keyOf(source, env) {
  const context = { process: { env }, hashed: [] };
  vm.createContext(context);
  vm.runInContext(`${source};var key=Vpr;`, context);
  return { key: context.key, hashed: context.hashed };
}

const at = (text, onScreen, columns = 120, isFullscreen = true) => ({
  viewport: { columns, isFullscreen },
  props: onScreen === undefined ? { text } : { text, onScreen },
});

test("patches the one value key and declares its helper beside it", () => {
  const result = patchPluginRenderStableOnScreen(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.ok(result.content.includes("var __calicoStableOnScreenSeen=new WeakMap;"));
  assert.match(result.content, /function __calicoStableOnScreenProps\(p\)\{if\(process\.env\.CALICO_STABLE_ONSCREEN!=="1"/);
  assert.ok(result.content.includes('kos(__calicoStableOnScreenProps(e.props))].join("\\x00");'));
  assert.ok(result.content.includes(hasher), "the hasher is left alone");
  assert.equal(evaluatePatchModule("plugin-render-stable-onscreen", result.content), null);
});

test("a second run changes nothing", () => {
  const once = patchPluginRenderStableOnScreen(fixture).content;
  const twice = patchPluginRenderStableOnScreen(once);
  assert.equal(twice.content, once);
  assert.equal(twice.patched, 0);
  assert.equal(twice.candidates, 1, "already patched, told apart from a reshaped key");
});

test("an unknown shape or a second site patches nothing", () => {
  const reshaped = fixture.replace("e.viewport?.isFullscreen", "e.viewport?.fullscreen");
  const none = patchPluginRenderStableOnScreen(reshaped);
  assert.equal(none.patched, 0);
  assert.equal(none.content, reshaped);
  assert.notEqual(evaluatePatchModule("plugin-render-stable-onscreen", reshaped), null);

  const doubled = `${fixture}${stockKey.replace("var Vpr", "var Wpr")}`;
  const two = patchPluginRenderStableOnScreen(doubled);
  assert.equal(two.candidates, 2);
  assert.equal(two.patched, 0);
  assert.equal(two.content, doubled);
});

test("the verifier runs the helper and rejects one that drops null-ness", () => {
  const patched = patchPluginRenderStableOnScreen(fixture).content;
  const dropped = patched.replace("onScreen:p.onScreen==null?p.onScreen:1", () => "onScreen:1");
  assert.match(evaluatePatchModule("plugin-render-stable-onscreen", dropped), /off-screen row no longer keys as null/);
  const ungated = patched.replace('process.env.CALICO_STABLE_ONSCREEN!=="1"', () => "!1");
  assert.match(evaluatePatchModule("plugin-render-stable-onscreen", ungated), /does not read CALICO_STABLE_ONSCREEN on each call/);
});

test("the verifier rejects the unpatched key", () => {
  assert.match(
    evaluatePatchModule("plugin-render-stable-onscreen", fixture),
    /still hashing props with onScreen/
  );
});

test("without the env the key still changes with onScreen, exactly as stock", () => {
  const patched = patchPluginRenderStableOnScreen(fixture).content;
  for (const env of [{}, { CALICO_STABLE_ONSCREEN: "0" }, { CALICO_STABLE_ONSCREEN: "true" }]) {
    const { key } = keyOf(patched, env);
    const { key: stock } = keyOf(fixture, env);
    const a = at("hello", { first: 0, last: 4, of: 9 });
    const b = at("hello", { first: 3, last: 7, of: 9 });
    assert.notEqual(key(a), key(b));
    assert.equal(key(a), stock(a));
    assert.equal(key(b), stock(b));
  }
});

test("with CALICO_STABLE_ONSCREEN=1 only the row range stops changing the key", () => {
  const patched = patchPluginRenderStableOnScreen(fixture).content;
  const { key } = keyOf(patched, { CALICO_STABLE_ONSCREEN: "1" });
  const visible = key(at("hello", { first: 0, last: 4, of: 9 }));
  assert.equal(key(at("hello", { first: 3, last: 7, of: 9 })), visible, "another row range");
  assert.equal(key(at("hello", { first: 8, last: 8, of: 9 })), visible, "the last row only");
  const outside = key(at("hello", null));
  assert.notEqual(outside, visible, "leaving the viewport still re-keys, so the engine's held rows stay right");
  assert.equal(key(at("hello", null)), outside);
  const { key: stock } = keyOf(fixture, { CALICO_STABLE_ONSCREEN: "1" });
  assert.equal(key(at("hello")), stock(at("hello")), "props without onScreen hash as stock");
  assert.notEqual(key(at("hello!", { first: 0, last: 4, of: 9 })), visible, "text");
  assert.notEqual(key(at("hello", { first: 0, last: 4, of: 9 }, 80)), visible, "columns");
  assert.notEqual(key(at("hello", { first: 0, last: 4, of: 9 }, 120, false)), visible, "isFullscreen");
});

test("the copy is memoized on the props object: one hash per object the row builds", () => {
  const patched = patchPluginRenderStableOnScreen(fixture).content;
  const { key, hashed } = keyOf(patched, { CALICO_STABLE_ONSCREEN: "1" });
  // The row passes a new props object whenever onScreen changes, and the same
  // object to the three key computations of one render.
  const first = Object.freeze(at("hello", Object.freeze({ first: 0, last: 4, of: 9 })));
  key(first);
  key(first);
  key(first);
  assert.equal(hashed.length, 1, "three computations of one render share one hash");
  const scrolled = Object.freeze(at("hello", Object.freeze({ first: 3, last: 7, of: 9 })));
  assert.equal(key(scrolled), key(first));
  assert.equal(hashed.length, 2, "a new props object costs one serialization, as stock");
  assert.equal(hashed[0].onScreen, 1);
  assert.deepEqual(first.props.onScreen, { first: 0, last: 4, of: 9 }, "the engine's props are not mutated");
});

test("the env is read on each call, so a value set after the chunk loads still counts", () => {
  const patched = patchPluginRenderStableOnScreen(fixture).content;
  const env = {};
  const { key } = keyOf(patched, env);
  const a = at("hello", { first: 0, last: 4, of: 9 });
  const b = at("hello", { first: 3, last: 7, of: 9 });
  assert.notEqual(key(a), key(b), "stock while unset");
  env.CALICO_STABLE_ONSCREEN = "1";
  const c = at("hello", { first: 0, last: 4, of: 9 });
  const d = at("hello", { first: 3, last: 7, of: 9 });
  assert.equal(key(c), key(d), "set later, as the settings.json env block does at startup");
});

test("minified names carrying $ are emitted verbatim", () => {
  const dollar = fixture
    .replace("var kos=Eos();", () => "var k$$=Eos();")
    .replace(stockKey, () => 'var $1e=(e$)=>[e$.viewport?.columns??"",e$.viewport?.isFullscreen??"",k$$(e$.props)].join("\\x00");');
  const result = patchPluginRenderStableOnScreen(dollar);
  assert.equal(result.patched, 1);
  assert.ok(result.content.includes('var $1e=(e$)=>[e$.viewport?.columns??"",e$.viewport?.isFullscreen??"",k$$(__calicoStableOnScreenProps(e$.props))].join("\\x00");'));
  assert.equal(evaluatePatchModule("plugin-render-stable-onscreen", result.content), null);
});
