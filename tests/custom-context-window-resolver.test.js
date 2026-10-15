// The context-window resolver keeps being reshaped by upstream, and each time
// the module kept applying with fewer candidates instead of failing:
// - 2.1.257 renamed the second parameter (4 -> 1);
// - 2.1.260 wrapped the headers parameter in a helper call (4 -> 3);
// - 2.1.295 folded both 1M checks into one two-parameter helper (4 -> 3);
// - 2.1.301 moved the override lookup out into a one-parameter helper (4 -> 3).
// `--assert-all` only fails at zero, so none of these losses was visible there;
// from 2.1.260 on the verifier caught them, because the resolver site is what
// injects both markers. The module is now all-or-nothing, so the next reshape
// reports zero patched and fails --assert-all instead.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchCustomContextWindows } = require("../patch-claude-display.ts");

// The module's other three sites, so each resolver fixture is patchable as a
// whole: the effective-window gate, the precompute bypass and the status-line
// consumer of __calico_display_window.
const effectiveSite =
  "function effective(e,t){let r=Math.min(resolve(e),t),n=precomputeGate()?t:void 0,{window:o}=derive(e,n);return o-r}";
const precomputeSite =
  "function precompute(e,t){return Math.min(e-Math.round(e*t.precomputeBufferFraction),effective(e,t))}";
const statusSite = "function status(f,u,w){return{context_window:f(u,w),exceeds_200k_tokens:!1}}";
const otherSites = effectiveSite + precomputeSite + statusSite;

// Each known spelling of the resolver, minified names and all.
const bare =
  "function wL(e,n){if(ou(e))return 1e6;if(n?.includes(vx.header)&&wv(e))return 1e6;" +
  "let r=Vvn(e);if(r!==void 0)return tCt(e)??r.believed;return 200000}";
const wrapped =
  "function tU(e,n){if(Vc(e))return 1e6;if(RYe(n)?.includes(rP.header)&&RC(e))return 1e6;" +
  "let r=jEn(e);if(r!==void 0)return oEt(e)??r.believed;return 200000}";
const folded =
  "function Qv(e,n){if(RUn(e,n))return 1e6;let r=Lyo(e);if(r!==void 0)return xUn(e)??r.believed;" +
  "if(wE(e))return 1e6;return 200000}";
// The wrapper and its one-parameter helper, as 2.1.301 ships them.
const split =
  "function Mv(e,n){if(RKn(e,n))return 1e6;let r=RU(e);return Zc(e)&&Man(e)===null?Math.min(r,CXe):r}" +
  "function RU(e){let n=MHr(e);if(n!==void 0)return Man(e)??n.believed;if(Bk(e))return 1e6;return 200000}";

for (const [name, resolver] of [
  ["2.1.259 reads the headers parameter directly", bare],
  ["2.1.260 passes it through a helper first", wrapped],
  ["2.1.295 folds both 1M checks into one helper", folded],
  ["2.1.301 splits the override lookup into a helper", split],
]) {
  test(`resolver is patched when ${name}`, () => {
    const result = patchCustomContextWindows(resolver + otherSites);
    assert.equal(result.candidates, 4);
    assert.equal(result.patched, 4);
    // Both markers the verifier checks come from the resolver site.
    assert.ok(result.content.includes("__calico_context_window"));
    assert.ok(result.content.includes("CALICO_CONTEXT_DISPLAY_PERCENT"));
    // Exactly one injection, reading the model parameter, followed by the
    // whole original body unchanged.
    assert.equal(result.content.split("function __calico_context_window(").length, 2);
    const originalBody = resolver.slice(resolver.indexOf("){") + 2);
    assert.ok(
      result.content.includes(
        "let __calico_window=__calico_context_window(e);if(__calico_window!==null)return __calico_window;" + originalBody
      )
    );
  });
}

// 2.1.301's injection goes into the wrapper, not the helper. A mapping must win
// over every upstream rule, and with no mapping the wrapper must behave exactly
// as shipped: its 1M early return and its new 200K cap. Executed rather than
// matched as text.
test("2.1.301 wrapper returns the mapped window and otherwise behaves as shipped", () => {
  const { content } = patchCustomContextWindows(split + otherSites);
  // Stub the upstream helpers. By default: no header 1M, no override, and the
  // model takes the capped path (Zc true, Man null), with the cap lower than
  // RU's default so its effect is visible.
  const run = (env, stubs = {}) => {
    const context = {
      process: { env },
      RKn: () => false,
      MHr: () => undefined,
      Bk: () => false,
      Man: () => null,
      Zc: () => true,
      CXe: 150000,
      ...stubs,
    };
    vm.createContext(context);
    vm.runInContext(content, context);
    return context;
  };
  const mapped = { CALICO_MODEL_CONTEXT_WINDOWS: JSON.stringify({ "gpt-5.6-sol": 372000 }) };
  const header1m = { RKn: () => true };
  const uncapped = { Zc: () => false };

  // A mapping wins, including over the header 1M check and the cap.
  assert.equal(run(mapped).Mv("gpt-5.6-sol", []), 372000);
  assert.equal(run(mapped, header1m).Mv("gpt-5.6-sol", []), 372000);
  // No mapping applies: the wrapper's own rules, unchanged.
  for (const env of [mapped, {}]) {
    assert.equal(run(env).Mv("other-model", []), 150000);
    assert.equal(run(env, header1m).Mv("other-model", []), 1e6);
    assert.equal(run(env, uncapped).Mv("other-model", []), 200000);
  }
  // The helper itself is untouched.
  assert.equal(run(mapped).RU("gpt-5.6-sol"), 200000);
});

// Missing or duplicated resolver: nothing is rewritten, so the status-line site
// never calls a __calico_display_window that no injection defines.
test("the module is all-or-nothing", () => {
  for (const [name, source, candidates] of [
    ["no resolver", otherSites, 3],
    ["unrecognised resolver", "function Mv(e,n){return 200000}" + otherSites, 3],
    ["two resolvers", folded + split + otherSites, 5],
    ["no status-line site", split + effectiveSite + precomputeSite, 3],
  ]) {
    const result = patchCustomContextWindows(source);
    assert.equal(result.patched, 0, name);
    assert.equal(result.candidates, candidates, name);
    assert.equal(result.content, source, name);
  }
});

// The wrapped form admits one wrapping call, not any expression: a resolver
// whose second `if` tests something unrelated is not this site.
test("a resolver that does not test the headers parameter is left alone", () => {
  const unrelated =
    "function tU(e,n){if(Vc(e))return 1e6;if(RYe(z)?.includes(rP.header)&&RC(e))return 1e6;return 200000}" +
    otherSites;
  const result = patchCustomContextWindows(unrelated);
  assert.equal(result.patched, 0);
  assert.equal(result.content, unrelated);
});

// The folded and split shapes begin with a helper call that says nothing about
// headers by itself, so each is pinned to the parameter order and to what
// follows: the override lookup (2.1.295), or the wrapper returning the
// helper's result (2.1.301).
test("a folded- or split-shape function that is not the resolver is left alone", () => {
  for (const decoy of [
    folded.replace("RUn(e,n)", "RUn(n,e)"),
    folded.replace("if(r!==void 0)return", "if(r)return"),
    // Neither the lookup nor the wrapper's return of the helper's result.
    folded.replace("if(r!==void 0)return", "return"),
    split.replace("RKn(e,n)", "RKn(n,e)"),
    split.replace("let r=RU(e)", "let r=RU(n)"),
    // Returns something other than the helper's result.
    split.replace("Math.min(r,CXe):r}", "Math.min(r,CXe):CXe}"),
  ]) {
    const source = decoy + otherSites;
    const result = patchCustomContextWindows(source);
    assert.equal(result.patched, 0, decoy);
    assert.equal(result.content, source, decoy);
  }
});

// The effective-window site is a separate rewrite in the same module; losing it
// used to leave the module "patched" by the resolver alone, and only the
// verifier's gate check noticed when 2.1.287 changed the reserve operand. Each
// fixture is the real function from that release, minified names and all.
for (const [name, effective, windowLocal] of [
  ["2.1.285 reserves from a helper over the model", "function BK(e,n){let r=Math.min(rst(e.model),Mht),s=Uf()?n:void 0,{window:g}=XA(e,s);return g-r}", "g"],
  ["2.1.287 reserves from maxOutputTokens", "function YV(e,n){let r=Math.min(e.maxOutputTokens,F_t),s=bm()?n:void 0,{window:g}=wE(e,s);return g-r}", "g"],
]) {
  test(`effective window is gated when ${name}`, () => {
    const result = patchCustomContextWindows(split + effective + precomputeSite + statusSite);
    assert.equal(result.patched, 4);
    assert.ok(result.content.includes(`return process.env.CALICO_MODEL_CONTEXT_WINDOWS?${windowLocal}:${windowLocal}-r}`));
  });
}
