// The context-window resolver has been reshaped twice by upstream, and both
// times the module kept applying with fewer candidates instead of failing:
// 2.1.257 renamed the second parameter (4 -> 1), and 2.1.260 stopped reading it
// directly, wrapping it in a helper call (4 -> 3). `--assert-all` only fails at
// zero, so neither loss was visible there; on 2.1.260 the verifier caught it,
// because the resolver site is what injects both markers.
const assert = require("node:assert/strict");
const test = require("node:test");

const { patchCustomContextWindows } = require("../patch-claude-display.ts");

// Both spellings of the same resolver, minified names and all.
const bare =
  "function wL(e,n){if(ou(e))return 1e6;if(n?.includes(vx.header)&&wv(e))return 1e6;" +
  "let r=Vvn(e);if(r!==void 0)return tCt(e)??r.believed;return 200000}";
const wrapped =
  "function tU(e,n){if(Vc(e))return 1e6;if(RYe(n)?.includes(rP.header)&&RC(e))return 1e6;" +
  "let r=jEn(e);if(r!==void 0)return oEt(e)??r.believed;return 200000}";

for (const [name, fixture] of [
  ["2.1.259 reads the headers parameter directly", bare],
  ["2.1.260 passes it through a helper first", wrapped],
]) {
  test(`resolver is patched when ${name}`, () => {
    const result = patchCustomContextWindows(fixture);
    assert.equal(result.candidates, 1);
    assert.equal(result.patched, 1);
    // Both markers the verifier checks come from this site.
    assert.ok(result.content.includes("__calico_context_window"));
    assert.ok(result.content.includes("CALICO_CONTEXT_DISPLAY_PERCENT"));
    // The lookup must read the model parameter, and the original body must
    // survive after the early return.
    assert.match(result.content, /let __calico_window=__calico_context_window\(e\);/);
    assert.ok(result.content.includes("if(__calico_window!==null)return __calico_window;"));
    assert.ok(result.content.includes("return 200000}"));
  });
}

// The relaxation admits one wrapping call, not any expression: a resolver whose
// second `if` tests something unrelated is not this site.
test("a resolver that does not test the headers parameter is left alone", () => {
  const unrelated =
    "function tU(e,n){if(Vc(e))return 1e6;if(RYe(z)?.includes(rP.header)&&RC(e))return 1e6;return 200000}";
  const result = patchCustomContextWindows(unrelated);
  assert.equal(result.patched, 0);
  assert.equal(result.content, unrelated);
});
