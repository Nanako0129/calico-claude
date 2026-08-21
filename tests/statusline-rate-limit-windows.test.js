const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchStatuslineRateLimitWindows } = require("../patch-claude-display.ts");

// Mirrors the upstream statusline payload builder: the header-derived state is
// read once, projected into a two-window object, and spread into the payload
// behind a guard that only knows about those same two windows.
const fixture = `
var state={};
function setState(next){state=next}
function tLn(){return state}
function hqw(){let k=tLn(),A={...k.five_hour&&{five_hour:{used_percentage:k.five_hour.utilization*100,resets_at:k.five_hour.resets_at}},...k.seven_day&&{seven_day:{used_percentage:k.seven_day.utilization*100,resets_at:k.seven_day.resets_at}}};return{model:{id:"sonnet"},...(A.five_hour||A.seven_day)&&{rate_limits:A},thinking:{enabled:!0}}}
`;

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
