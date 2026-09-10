// The CLI's `/compact` completion line reports nothing about what the
// compaction bought, while the Claude mobile app prints "saved 256.3k tokens".
// Both numbers are already in the CLI, one function apart. This module renders
// the difference.
//
// The assertions here run the patched code rather than grepping it. A text
// check cannot tell a segment that renders from one that renders "NaN", nor a
// stale figure left over from the previous compaction from a fresh one — and
// those are the two ways this can be wrong while every marker is present.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchCompactTokensSaved } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The shape measured in 2.1.259 through 2.1.263, reduced to what the two
// patterns actually pin. `w` is the renderer's real minified name on every one
// of those versions; it is also the name of 111 other functions in the bundle,
// which is why nothing here matches on it.
//
// `era` picks how the compaction result reaches the renderer. Up to 2.1.266 it
// is spread as `<local>.result` and carries `preCompactTokenCount`; 2.1.267
// restructured the command around a `compact:` callback, spreads the result
// directly, and reads the pre-compaction figure from
// `compactMetadata.preTokens` instead. Requiring the `.result` suffix took the
// module to zero candidates on 2.1.267 and blocked the release.
const fixture = (resultVar, era = "pre267") => `
var ie={dim:(s)=>"DIM("+s+")"};
function T4(){return tipText}
function p_(){return"ctrl+o"}
function w(s,e){let n=T4("tip"),o=p_("app:toggleTranscript","Global","ctrl+o"),m=[...s.options.verbose?[]:[\`(\${o} to see full summary)\`],...e?[e]:[],...n?[n]:[]];return ie.dim("Compacted "+m.join(\`\\n\`))}
function finish(${resultVar},e,y){return{type:"compact",compactionResult:{...${resultVar}${era === "pre267" ? ".result" : ""},userDisplayMessage:y},displayText:w(e,y)}}
function renderOnly(e,y){return w(e,y)}
`;

// Pre-2.1.267 shape: the wrapper carries `.result`, pre lives on the result.
const outcome = (pre, post) => ({
  result: {
    preCompactTokenCount: pre,
    boundaryMarker:
      post === undefined
        ? { subtype: "compact_summary" }
        : { subtype: "compact_boundary", compactMetadata: { postTokens: post } },
  },
});

// 2.1.267 shape: the result is spread directly and both figures live on
// compactMetadata. No `preCompactTokenCount` at all, so the fallback is the
// only source.
const outcome267 = (pre, post) =>
  post === undefined
    ? { boundaryMarker: { subtype: "compact_summary" } }
    : { boundaryMarker: { subtype: "compact_boundary", compactMetadata: { preTokens: pre, postTokens: post } } };

function load(resultVar = "u", era = "pre267") {
  const result = patchCompactTokensSaved(fixture(resultVar, era));
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("compact-tokens-saved", result.content), null);

  const context = { tipText: undefined };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  return { context, result };
}

const compact = (context, pre, post, options = { verbose: false }) =>
  context.finish(outcome(pre, post), { options }, undefined).displayText;

// 256.3k is the figure from the mobile app screenshot this was built against.
test("renders the saving on the compacted line", () => {
  const { context } = load();
  assert.equal(
    compact(context, 300000, 43700),
    "DIM(Compacted · saved 256.3k tokens (ctrl+o to see full summary))"
  );
});

test("scales the unit to the size of the saving", () => {
  const { context } = load();
  assert.match(compact(context, 1200, 260), /saved 940 tokens/);
  assert.match(compact(context, 12000, 2600), /saved 9.4k tokens/);
  assert.match(compact(context, 1400000, 150000), /saved 1.3M tokens/);
});

// The boundary marker only carries postTokens when its subtype is
// "compact_boundary". Reading through it unguarded would render "saved NaN
// tokens", which is worse than the line the patch replaces.
test("omits the segment when either number is missing or nonsensical", () => {
  const { context } = load();
  for (const [pre, post] of [
    [300000, undefined],
    [undefined, 43700],
    [43700, 300000],
    [300000, 300000],
  ]) {
    assert.equal(
      compact(context, pre, post),
      "DIM(Compacted (ctrl+o to see full summary))",
      `pre=${pre} post=${post} should render no saving`
    );
  }
});

// The producer and consumer are one expression apart today. If a later release
// reaches the renderer by some other path, it must show nothing rather than the
// previous compaction's figure — a wrong number that looks right.
test("the saving is consumed once and not repeated", () => {
  const { context } = load();
  assert.match(compact(context, 300000, 43700), /saved 256.3k tokens/);
  assert.equal(
    context.renderOnly({ options: { verbose: false } }, undefined),
    "DIM(Compacted (ctrl+o to see full summary))"
  );
});

// verbose drops the transcript hint, leaving the saving as the only element.
test("survives the renderer's other list elements", () => {
  const { context } = load();
  assert.equal(
    compact(context, 300000, 43700, { verbose: true }),
    "DIM(Compacted · saved 256.3k tokens )"
  );
  context.tipText = "a tip";
  assert.equal(
    compact(context, 300000, 43700),
    "DIM(Compacted · saved 256.3k tokens (ctrl+o to see full summary)\na tip)"
  );
});

// 2.1.259 and 2.1.260 name the result local `p`, 2.1.261 and 2.1.263 name it
// `u`. Nothing in either pattern may depend on which.
test("does not depend on the minified result local", () => {
  const { context } = load("p");
  assert.match(compact(context, 300000, 43700), /saved 256.3k tokens/);
});

// 2.1.267: the result is spread bare and the pre-compaction figure moved onto
// compactMetadata. This is the drift that blocked the 2.1.267 release, so it
// gets its own case rather than a relaxed assertion on the old one.
test("handles the 2.1.267 bare spread with preTokens on compactMetadata", () => {
  const { context } = load("k", "post267");
  const render = (pre, post) =>
    context.finish(outcome267(pre, post), { options: { verbose: false } }, undefined).displayText;

  assert.equal(
    render(300000, 43700),
    "DIM(Compacted · saved 256.3k tokens (ctrl+o to see full summary))"
  );
  // Still fails closed when the marker carries no metadata.
  assert.equal(render(300000, undefined), "DIM(Compacted (ctrl+o to see full summary))");
  // And when the compaction did not shrink anything.
  assert.equal(render(43700, 300000), "DIM(Compacted (ctrl+o to see full summary))");
});

// preCompactTokenCount wins when both are present, so a bundle carrying the old
// field keeps reading it rather than silently switching source.
test("prefers preCompactTokenCount over compactMetadata.preTokens", () => {
  const { context } = load();
  const both = {
    result: {
      preCompactTokenCount: 300000,
      boundaryMarker: {
        subtype: "compact_boundary",
        compactMetadata: { preTokens: 999999, postTokens: 43700 },
      },
    },
  };
  assert.match(
    context.finish(both, { options: { verbose: false } }, undefined).displayText,
    /saved 256\.3k tokens/
  );
});

test("re-patching an already patched bundle changes nothing", () => {
  const once = patchCompactTokensSaved(fixture("u"));
  const twice = patchCompactTokensSaved(once.content);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once.content);
});

// Applying the two injections independently would let a bundle that kept only
// one anchor come out partially rewritten with `patched === 1`. --assert-all
// only fails at zero, and `npm run patch:native` does not invoke the verifier,
// so that build would be reported successful with the feature doing nothing:
// a producer nothing reads, or a consumer reading undefined and concatenating
// "". Neither breaks the binary, which is why neither would be noticed.
test("applies both injections or neither", () => {
  const full = fixture("u");
  const producerOnly = full.replace('ie.dim("Compacted "+', 'ie.dim("Summarised "+');
  const consumerOnly = full.replace("displayText:w(e,y)", "displayText:y");

  for (const [name, bundle, expectedCandidates] of [
    ["only the call site survives", producerOnly, 1],
    ["only the render site survives", consumerOnly, 1],
  ]) {
    const result = patchCompactTokensSaved(bundle);
    assert.equal(result.patched, 0, name);
    assert.equal(result.content, bundle, `${name}: content must be untouched`);
    // Non-zero candidates with zero patched is what makes --assert-all fail
    // loudly and name this module, rather than shipping the silent version.
    assert.equal(result.candidates, expectedCandidates, name);
  }
});

test("leaves an unrelated compact command alone", () => {
  // Same field names, but the display text is not built from the renderer this
  // module rewrites, so there is nothing to sequence the value with.
  const unrelated =
    'function finish(u,e,y){return{type:"compact",compactionResult:{...u.result,userDisplayMessage:y},displayText:y}}';
  const result = patchCompactTokensSaved(unrelated);
  assert.equal(result.patched, 0);
  assert.equal(result.content, unrelated);
});
