// The context-window resolver keeps being reshaped by upstream, and each time
// the module kept applying with fewer candidates instead of failing:
// - 2.1.257 renamed the second parameter (4 -> 1);
// - 2.1.260 wrapped the headers parameter in a helper call (4 -> 3);
// - 2.1.295 folded both 1M checks into one two-parameter helper (4 -> 3);
// - 2.1.301 moved the override lookup out into a one-parameter helper (4 -> 3).
// `--assert-all` only fails at zero, so none of these losses was visible there;
// from 2.1.260 on the verifier caught them, because the resolver site is what
// injects both markers. The module is now all-or-nothing, so the next reshape
// reports zero patched and fails --assert-all instead: 2.1.305 (a block for the
// 1M check, a second lookup) did exactly that, 3 candidates and 0 patched.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchCustomContextWindows } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

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
// 2.1.305: the 1M check is a block returning the catalog window, and a second
// one-parameter lookup runs before the helper. The wrapper as shipped; the
// helper bodies are shortened.
const blocked =
  "function pE(e,n){if(mXn(e,n)){let h=Xa(qe(Mt(e)))?.context;return Math.max(h?.maximum_window??h?.window??0,n0)}" +
  "let r=s5s(e);if(r!==null)return r;let s=o0(e);return kf(e)&&X_t(e)===null?Math.min(s,MCe):s}" +
  "function o0(e){return 200000}";
// 2.1.324: a third parameter threaded into the 1M check and both lookups, and a
// global override (`let s=IC();if(s!==void 0)return s;`) ahead of everything.
const overridden =
  "function T1(e,n,r){let s=IC();if(s!==void 0)return s;if(RVr(e,n,r)){let E=bo(lt($t(e)));" +
  "return Math.max(xC(e,r),E?.maximum_window??E?.window??0,S1)}" +
  "let h=IRa(e,r);if(h!==null)return h;let y=xC(e,r);return vVt(e,r)===null?Math.min(y,r_(e)):y}" +
  "function xC(e,n){return 200000}";

for (const [name, resolver] of [
  ["2.1.259 reads the headers parameter directly", bare],
  ["2.1.260 passes it through a helper first", wrapped],
  ["2.1.295 folds both 1M checks into one helper", folded],
  ["2.1.301 splits the override lookup into a helper", split],
  ["2.1.305 blocks the 1M check and adds a second lookup", blocked],
  ["2.1.324 adds a third parameter and a global override", overridden],
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

// The same contract on 2.1.305: a mapping wins over the 1M block and the new
// lookup; without one, each upstream rule behaves as shipped.
test("2.1.305 wrapper returns the mapped window and otherwise behaves as shipped", () => {
  const { content } = patchCustomContextWindows(blocked + otherSites);
  const run = (env, stubs = {}) => {
    const context = {
      process: { env },
      mXn: () => false,
      Xa: () => ({ context: { window: 1000000 } }),
      qe: (x) => x,
      Mt: (x) => x,
      n0: 0,
      s5s: () => null,
      kf: () => true,
      X_t: () => null,
      MCe: 150000,
      ...stubs,
    };
    vm.createContext(context);
    vm.runInContext(content, context);
    return context.pE;
  };
  const mapped = { CALICO_MODEL_CONTEXT_WINDOWS: JSON.stringify({ "gpt-5.6-sol": 372000 }) };
  const oneMillion = { mXn: () => true };
  const looked = { s5s: () => 512000 };

  assert.equal(run(mapped)("gpt-5.6-sol", []), 372000);
  assert.equal(run(mapped, oneMillion)("gpt-5.6-sol", []), 372000);
  assert.equal(run(mapped, looked)("gpt-5.6-sol", []), 372000);
  for (const env of [mapped, {}]) {
    assert.equal(run(env)("other-model", []), 150000, "capped helper result");
    assert.equal(run(env, oneMillion)("other-model", []), 1000000, "catalog window from the block");
    assert.equal(run(env, looked)("other-model", []), 512000, "the new lookup");
    assert.equal(run(env, { kf: () => false })("other-model", []), 200000, "uncapped helper result");
  }
});

// 2.1.324: a mapping wins over the new global override as well as the 1M block
// and the lookup; without one, each upstream rule behaves as shipped, and the
// third parameter still reaches the helpers.
test("2.1.324 resolver returns the mapped window and otherwise behaves as shipped", () => {
  const { content } = patchCustomContextWindows(overridden + otherSites);
  const run = (vars, stubs = {}) => {
    const seen = [];
    const context = {
      process: { ["e" + "nv"]: vars },
      IC: () => undefined,
      RVr: () => false,
      bo: () => ({ window: 1000000 }),
      lt: (x) => x,
      $t: (x) => x,
      S1: 0,
      IRa: (e, r) => (seen.push(r), null),
      vVt: () => null,
      r_: () => 150000,
      ...stubs,
    };
    vm.createContext(context);
    vm.runInContext(content, context);
    return { call: (...args) => context.T1(...args), seen };
  };
  const mapped = { CALICO_MODEL_CONTEXT_WINDOWS: JSON.stringify({ "gpt-5.6-sol": 372000 }) };
  const overrideSet = { IC: () => 640000 };
  const oneMillion = { RVr: () => true };
  const looked = { IRa: () => 512000 };

  for (const stubs of [{}, overrideSet, oneMillion, looked]) {
    assert.equal(run(mapped, stubs).call("gpt-5.6-sol", [], { o: 1 }), 372000);
  }
  for (const vars of [mapped, {}]) {
    assert.equal(run(vars).call("other-model", [], {}), 150000, "capped helper result");
    assert.equal(run(vars, overrideSet).call("other-model", [], {}), 640000, "global override");
    assert.equal(run(vars, oneMillion).call("other-model", [], {}), 1000000, "catalog window from the block");
    assert.equal(run(vars, looked).call("other-model", [], {}), 512000, "the lookup");
  }
  const probe = run({});
  const overrides = { tag: "third" };
  probe.call("other-model", [], overrides);
  assert.equal(probe.seen[0], overrides, "the third parameter reaches the lookup");
});

// Review of PR #94: the third parameter belongs to the 2.1.324 shape only, and
// it must be the one threaded into the 1M check and both lookups.
test("only the 2.1.324 shape takes a third parameter, and it must be threaded through", () => {
  const threeParamOld = blocked.replace("function pE(e,n){", "function pE(e,n,r){");
  assert.equal(patchCustomContextWindows(threeParamOld + otherSites).patched, 0);
  const twoParamNew = overridden.replace("function T1(e,n,r){", "function T1(e,n){");
  assert.equal(patchCustomContextWindows(twoParamNew + otherSites).patched, 0);
  const otherLocal = overridden.replace("let h=IRa(e,r);", "let h=IRa(e,t);");
  assert.notEqual(otherLocal, overridden);
  assert.equal(patchCustomContextWindows(otherLocal + otherSites).patched, 0);
});

test("the verifier requires the lookup to be the resolver's first statement", () => {
  const { content } = patchCustomContextWindows(overridden + otherSites);
  assert.equal(evaluatePatchModule("custom-context-window", content), null);
  const late = content.replace(
    "function T1(e,n,r){let __calico_window=__calico_context_window(e);if(__calico_window!==null)return __calico_window;let s=IC();if(s!==void 0)return s;",
    "function T1(e,n,r){let s=IC();if(s!==void 0)return s;let __calico_window=__calico_context_window(e);if(__calico_window!==null)return __calico_window;"
  );
  assert.notEqual(late, content);
  assert.match(String(evaluatePatchModule("custom-context-window", late)), /first statement/);
});

// Missing or duplicated resolver: nothing is rewritten, so the status-line site
// never calls a __calico_display_window that no injection defines.
test("the module is all-or-nothing", () => {
  for (const [name, source, candidates] of [
    ["no resolver", otherSites, 3],
    ["unrecognised resolver", "function Mv(e,n){return 200000}" + otherSites, 3],
    ["two resolvers", folded + split + otherSites, 5],
    ["two resolvers, one of them 2.1.305", split + blocked + otherSites, 5],
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
    // 2.1.305 shape: parameter order, a lookup that is not returned when
    // non-null, a lookup on the headers parameter, and a tail that ignores
    // the helper's result.
    blocked.replace("mXn(e,n)", "mXn(n,e)"),
    blocked.replace("if(r!==null)return r;", "if(r!==null)return 0;"),
    blocked.replace("let r=s5s(e)", "let r=s5s(n)"),
    blocked.replace("Math.min(s,MCe):s}", "Math.min(s,MCe):MCe}"),
    // The block is matched as one brace-free unit: a block holding a nested
    // `{…}` is not this shape, so a loosened `[^{}]*` would show up here.
    blocked.replace("let h=Xa(qe(Mt(e)))?.context;", "if(h){h=0}let h=Xa(qe(Mt(e)))?.context;"),
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
