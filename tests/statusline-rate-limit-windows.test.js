const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchStatuslineRateLimitWindows } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const verify = (content) =>
  evaluatePatchModule("statusline-rate-limit-windows", content) ?? "PASS";

// Mirrors the upstream statusline payload builder: the header-derived state is
// read once, projected into a two-window object, and spread into the payload
// behind a guard that only knows about those same two windows.
const fixture = `
var state={};
function setState(next){state=next}
function tLn(){return state}
function hqw(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A},thinking:{enabled:!0}}}
`;

// 2.1.275 hoisted the percentage out of the object literal: every
// `k.five_hour.utilization*100` became `wQe(k.five_hour.utilization)`, whose
// measured definition in that bundle is
// `function wQe(t){return Math.round(t*1000)/10}`. The fixture carries a helper
// with that body so the assertions below measure the rounding upstream applies
// rather than a stand-in.
function normalizedFixture(helper = "wQe") {
  return `
var state={};
function setState(next){state=next}
function tLn(){return state}
function ${helper}(t){return Math.round(t*1000)/10}
function hqw(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:${helper}(k.five_hour.utilization),resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:${helper}(k.seven_day.utilization),resets_at:k.seven_day.resets_at}}};return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A},thinking:{enabled:!0}}}
`;
}

function runPatched(content) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(content, context);
  return context;
}

function windowState(utilization, resetsAt) {
  return { utilization, resets_at: resetsAt };
}

test("forwards all four header-derived rate-limit windows", () => {
  const result = patchStatuslineRateLimitWindows(fixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);

  const context = runPatched(result.content);
  context.setState({
    five_hour: windowState(0.125, 1),
    seven_day: windowState(0.25, 2),
    seven_day_overage_included: windowState(0.5, 3),
    overage: windowState(0.75, 4),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.hqw().rate_limits)), {
    five_hour: { used_percentage: 12.5, resets_at: 1 },
    seven_day: { used_percentage: 25, resets_at: 2 },
    seven_day_overage_included: { used_percentage: 50, resets_at: 3 },
    overage: { used_percentage: 75, resets_at: 4 },
  });
});

test("patches the 2.1.275 hoisted-percentage form", () => {
  const source = normalizedFixture();
  const result = patchStatuslineRateLimitWindows(source);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);

  const context = runPatched(result.content);
  context.setState({
    five_hour: windowState(0.125, 1),
    seven_day: windowState(0.25, 2),
    seven_day_overage_included: windowState(0.5, 3),
    overage: windowState(0.75, 4),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(context.hqw().rate_limits)), {
    five_hour: { used_percentage: 12.5, resets_at: 1 },
    seven_day: { used_percentage: 25, resets_at: 2 },
    seven_day_overage_included: { used_percentage: 50, resets_at: 3 },
    overage: { used_percentage: 75, resets_at: 4 },
  });
});

test("the added windows carry the same percentage spelling as the ones already there", () => {
  // The two halves of the drift are separable: the module can match the helper
  // form and still write `*100` into the windows it adds, which produces a
  // payload where two windows round to one decimal and two do not. Only a
  // measurement of the emitted text catches that; the values above agree
  // either way at these inputs.
  const normalized = patchStatuslineRateLimitWindows(normalizedFixture()).content;
  assert.equal(normalized.includes("utilization*100"), false, "no window may fall back to inline");
  assert.equal(
    (normalized.match(/wQe\(k\.[\w$]+\.utilization\)/g) || []).length,
    4,
    "all four windows go through upstream's helper"
  );

  // And the inline bundles keep the spelling they had, rather than acquiring a
  // helper that does not exist there.
  const bare = patchStatuslineRateLimitWindows(fixture).content;
  assert.equal(
    (bare.match(/utilization\*100/g) || []).length,
    4,
    "all four windows stay inline on a bundle with no helper"
  );
});

test("a helper named with a regex metacharacter still patches", () => {
  // Minified names reach `$`, and the helper is captured and re-emitted. `$e`
  // in a replacement string would also read as a substitution pattern.
  const source = normalizedFixture("$e");
  const result = patchStatuslineRateLimitWindows(source);
  assert.equal(result.patched, 2);
  assert.equal(
    (result.content.match(/\$e\(k\.[\w$]+\.utilization\)/g) || []).length,
    4,
    "the helper's name must survive verbatim into all four windows"
  );

  const context = runPatched(result.content);
  context.setState({ overage: windowState(0.3335, 9) });
  assert.deepEqual(JSON.parse(JSON.stringify(context.hqw().rate_limits)), {
    overage: { used_percentage: 33.4, resets_at: 9 },
  });
});

test("rejects a projection that mixes the two percentage spellings", () => {
  // Paired, not crossed: accept the spellings upstream actually emits. A
  // bundle whose two entries disagree is a shape this patcher has not seen,
  // and guessing which one the added windows should follow is how the halves
  // drift apart.
  const mixed = fixture.replace(
    "used_percentage:k.five_hour.utilization*100",
    "used_percentage:wQe(k.five_hour.utilization)"
  );
  const result = patchStatuslineRateLimitWindows(mixed);
  assert.equal(result.candidates, 1, "only the guard is found");
  assert.equal(result.patched, 0);
  assert.equal(result.content, mixed);
});

test("rejects a projection whose two entries use different helpers", () => {
  const twoHelpers = normalizedFixture().replace(
    "used_percentage:wQe(k.seven_day.utilization)",
    "used_percentage:xQe(k.seven_day.utilization)"
  );
  const result = patchStatuslineRateLimitWindows(twoHelpers);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 0);
  assert.equal(result.content, twoHelpers);
});

// The verifier is the last thing standing between a malformed re-emission and
// a published release, so it has to reject the shape the patcher refuses to
// produce — not merely confirm the four keys are present. Reading each window's
// spelling independently accepted a payload whose upstream windows rounded and
// whose added windows did not.
test("the verifier accepts both spellings when all four windows agree", () => {
  assert.equal(verify(patchStatuslineRateLimitWindows(fixture).content), "PASS");
  assert.equal(verify(patchStatuslineRateLimitWindows(normalizedFixture()).content), "PASS");
});

test("the verifier rejects a payload whose windows disagree on the spelling", () => {
  const patched = patchStatuslineRateLimitWindows(normalizedFixture()).content;
  const mixed = patched
    .replace(
      "seven_day_overage_included:{used_percentage:wQe(k.seven_day_overage_included.utilization)",
      "seven_day_overage_included:{used_percentage:k.seven_day_overage_included.utilization*100"
    )
    .replace(
      "overage:{used_percentage:wQe(k.overage.utilization)",
      "overage:{used_percentage:k.overage.utilization*100"
    );
  assert.notEqual(mixed, patched, "the mutation must reach the payload");
  assert.equal(verify(mixed), "forwarded rate-limit windows do not share one percentage spelling");
});

test("the verifier rejects a payload using two different helpers", () => {
  const patched = patchStatuslineRateLimitWindows(normalizedFixture()).content;
  const twoHelpers = patched.replace(
    "seven_day:{used_percentage:wQe(k.seven_day.utilization)",
    "seven_day:{used_percentage:xQe(k.seven_day.utilization)"
  );
  assert.notEqual(twoHelpers, patched);
  assert.equal(
    verify(twoHelpers),
    "forwarded rate-limit windows do not share one percentage spelling"
  );
});

test("the verifier still names a window that is genuinely absent", () => {
  // The consistency check must not swallow the older failure it replaced.
  const patched = patchStatuslineRateLimitWindows(normalizedFixture()).content;
  const dropped = patched.replace(
    ",...k.overage&&{overage:{used_percentage:wQe(k.overage.utilization),resets_at:k.overage.resets_at}}",
    ""
  );
  assert.notEqual(dropped, patched);
  assert.equal(verify(dropped), "missing forwarded rate-limit window(s): overage");
});

test("keeps the existing two-window payload byte-identical when only those exist", () => {
  const context = runPatched(patchStatuslineRateLimitWindows(fixture).content);
  const baseline = runPatched(fixture);
  const state = { five_hour: windowState(0.9, 11), seven_day: windowState(0.5, 22) };

  context.setState(state);
  baseline.setState(state);
  assert.equal(JSON.stringify(context.hqw()), JSON.stringify(baseline.hqw()));
});

test("emits rate_limits when only a Fable window is present", () => {
  const context = runPatched(patchStatuslineRateLimitWindows(fixture).content);
  const baseline = runPatched(fixture);
  const state = { seven_day_overage_included: windowState(0.5, 7) };

  context.setState(state);
  baseline.setState(state);
  // The upstream guard drops the whole object here, which is what the patch fixes.
  assert.equal(baseline.hqw().rate_limits, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(context.hqw().rate_limits)), {
    seven_day_overage_included: { used_percentage: 50, resets_at: 7 },
  });
});

test("omits rate_limits entirely when no window is known", () => {
  const context = runPatched(patchStatuslineRateLimitWindows(fixture).content);
  context.setState({});
  assert.equal("rate_limits" in context.hqw(), false);
});

test("leaves content untouched when either anchor is missing", () => {
  const guardOnly = fixture.replace(
    /let k=tLn\(\),A=\{[^;]*\};/,
    "let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization}}};"
  );
  const result = patchStatuslineRateLimitWindows(guardOnly);
  assert.equal(result.patched, 0);
  assert.equal(result.content, guardOnly);
});

test("is inert on already-patched content", () => {
  const once = patchStatuslineRateLimitWindows(fixture);
  const twice = patchStatuslineRateLimitWindows(once.content);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once.content);
});

// Global match counts alone do not prove the two anchors belong to each other.
// Both of the following carry each shape exactly once, so the counts look
// identical to the healthy fixture — only an ownership proof separates them.

test("rejects anchors that live in different payload builders", () => {
  const split = `
function projectOnly(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};return A}
function guardOnly(){let A=somethingElse();return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}
`;
  const result = patchStatuslineRateLimitWindows(split);
  assert.equal(result.candidates, 2, "both shapes are still found");
  assert.equal(result.patched, 0, "but they must not be rewritten");
  assert.equal(result.content, split);
});

test("rejects a projection that does not initialize the local the guard reads", () => {
  // Same function, and the guard's local `A` even exists — but the projection
  // is assigned to `B`, so widening the guard would not see the added windows.
  const unrelated = `
function hqw(){let k=tLn(),B={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}},A=somethingElse(B);return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}
`;
  const result = patchStatuslineRateLimitWindows(unrelated);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 0);
  assert.equal(result.content, unrelated);
});

test("rejects a projection trapped inside an arrow callback", () => {
  // The shape Codex raised on #8: same enclosing function, and the guard's local
  // name is even initialized by a projection — but that projection belongs to a
  // callback scope and a shadowed binding, so widening the guard would not see
  // the added windows. `lastIndexOf("function ")` cannot tell these apart.
  const shadowed = `
function hqw(){let k=tLn();items.map(()=>{let A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};return A});let A=somethingElse();return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}
`;
  const result = patchStatuslineRateLimitWindows(shadowed);
  assert.equal(result.candidates, 2, "both shapes are still found");
  assert.equal(result.patched, 0, "but the guard must not be widened");
  assert.equal(result.content, shadowed);
});

test("rejects a guard that precedes the projection it would have to consume", () => {
  const reversed = `
function hqw(){let k=tLn(),A=prior();let out={model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}};A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};return out}
`;
  const result = patchStatuslineRateLimitWindows(reversed);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 0);
});

test("rejects a guard whose local was re-declared in a deeper block", () => {
  // The inverse nesting raised on #8 round 3: the projection initializes the
  // outer `A`, then a deeper block declares its own `A` around the guard. The
  // bracket depth never goes negative, so the scope walk alone accepts it.
  const shadowedInner = `
function hqw(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};if(cond){let A=somethingElse();return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}return A}
`;
  const result = patchStatuslineRateLimitWindows(shadowedInner);
  assert.equal(result.candidates, 2, "both shapes are still found");
  assert.equal(result.patched, 0, "but the windows and the guard belong to different objects");
  assert.equal(result.content, shadowedInner);
});

test("rejects a guard whose local was reassigned after the projection", () => {
  // Not shadowing, but the same consequence: the projection's result is
  // discarded before the guard reads the local.
  const reassigned = `
function hqw(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};A=recompute(A);return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}
`;
  const result = patchStatuslineRateLimitWindows(reassigned);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 0);
});

// The binding forms below are all distinct syntax. They are covered by one
// condition — the guard's local must not occur between the anchors — rather
// than by a matcher per form, which is what kept admitting the next variant.
for (const [name, middle] of [
  ["an arrow parameter", `items.map((A)=>({...(A.five_hour||A.seven_day)&&{rate_limits:A}}));`],
  ["a destructured parameter", `items.map(({A})=>({...(A.five_hour||A.seven_day)&&{rate_limits:A}}));`],
  ["a catch binding", `try{x()}catch(A){log(A)};`],
  ["a for-loop binding", `for(let A of xs){use(A)};`],
]) {
  test(`rejects a guard shadowed by ${name}`, () => {
    const source = `
function hqw(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};${middle}return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}
`;
    const result = patchStatuslineRateLimitWindows(source);
    assert.equal(result.patched, 0, "the guard may not be rewritten");
    assert.equal(result.content, source);
  });
}

test("rejects a projection assigned to a property rather than the guard's local", () => {
  const propertyAssigned = `
function hqw(){let k=tLn(),A=elsewhere();x.A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A}}}
`;
  const result = patchStatuslineRateLimitWindows(propertyAssigned);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 0);
  assert.equal(result.content, propertyAssigned);
});

// Minified identifiers are not regex-safe. Bun emits names like `$e` and `$p`,
// and the ownership proof interpolated the guard's local straight into a
// RegExp, where `$` reads as an anchor rather than a character. 2.1.269 renamed
// this local from `Le` to `$e` and the module went from 2 patched to 0 —
// without the anchors drifting at all, which is why it did not look like the
// usual shape change: both patterns still matched, and the module rejected its
// own match.
//
// Run over every name that contains a metacharacter reachable from the
// minifier's alphabet, not just the one upstream happened to pick.
for (const local of ["$e", "$", "$$", "a$b", "_$"]) {
  test(`patches when the guard's local is spelled ${local}`, () => {
    // A function replacement, because `$` is special in a replacement *string*
    // too: `"$$="` collapses to `"$="` and the fixture would silently test the
    // wrong name.
    const rename = (text, from, to) => text.split(from).join(to);
    let source = rename(fixture, "A=", `${local}=`);
    source = rename(source, "A.", `${local}.`);
    source = rename(source, "A}", `${local}}`);
    assert.notEqual(source, fixture, `${local} fixture did not change`);
    assert.ok(source.includes(`${local}.five_hour`), `${local} fixture must carry the name verbatim`);

    const result = patchStatuslineRateLimitWindows(source);
    assert.equal(result.candidates, 2);
    assert.equal(result.patched, 2, `a local named ${local} must not defeat the ownership proof`);

    // And the rewrite still works end to end, not merely textually.
    const context = runPatched(result.content);
    context.setState({
      five_hour: windowState(0.5, 1),
      seven_day_overage_included: windowState(0.25, 2),
    });
    const payload = context.hqw();
    assert.equal(payload.rate_limits.five_hour.used_percentage, 50);
    assert.equal(payload.rate_limits.seven_day_overage_included.used_percentage, 25);
  });
}
