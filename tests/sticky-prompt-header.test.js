// The fullscreen sticky prompt header stopped rendering in 2.1.247
// (anthropics/claude-code#90299). Through 2.1.246 the component read the
// viewport on every render; 2.1.247 put the same reads behind compiler-style
// memoization keyed on the viewport handle, whose object identity never changes
// for the lifetime of the list. Every read is therefore frozen at its
// mount-time value — isSticky() true, because the view starts pinned to the
// bottom — and the prompt scan gated on `!isSticky` never runs again.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchStickyPromptHeader } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const VERSION_METADATA = 'var meta={PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"2.1.251"};';

// The 2.1.247+ shape: one component, one memo cache, three handle-keyed reads,
// then a scan memoized on the offset they derive.
const memoizedFixture = `${VERSION_METADATA}
function km(XE){let Eo=_(36),{messages:Fa,start:wn,end:cr,getItemTop:ur,scrollViewport:ot}=XE,{setStickyPrompt:dr}=Or(),rS;if(Eo[0]!==ot.handle)rS=()=>ot.handle,Eo[0]=ot.handle,Eo[1]=rS;else rS=Eo[1];Lt(ot.subscribe,rS);let iS;if(Eo[2]!==ot.handle)iS=ot.handle?.isSticky()??!0,Eo[2]=ot.handle,Eo[3]=iS;else iS=Eo[3];let Rm=iS,aS;if(Eo[4]!==ot.handle)aS=ot.handle?.getScrollTop()??0,Eo[4]=ot.handle,Eo[5]=aS;else aS=Eo[5];let lS;if(Eo[6]!==ot.handle)lS=ot.handle?.getPendingDelta()??0,Eo[6]=ot.handle,Eo[7]=lS;else lS=Eo[7];let pr=Math.max(0,aS+lS);dr(Rm?null:pr);return Rm}
`;

// Pre-2.1.247: same reads, no memo. The module must decline, not fail.
const plainFixture = `${VERSION_METADATA.replace("2.1.251", "2.1.246")}
function km(XE){let{scrollViewport:ot}=XE,{setStickyPrompt:dr}=Or();let Rm=ot.handle?.isSticky()??!0,pr=(ot.handle?.getScrollTop()??0)+(ot.handle?.getPendingDelta()??0);dr(Rm?null:pr);return Rm}
`;

// Drive the component the way the TUI does: mount while pinned to the bottom,
// then scroll. A frozen read keeps reporting the mount-time value.
function runComponent(source) {
  const context = {
    sticky: true,
    scrollTop: 0,
    published: [],
    handle: null,
  };
  vm.createContext(context);
  vm.runInContext(
    `var handle={isSticky:()=>sticky,getScrollTop:()=>scrollTop,getPendingDelta:()=>0};` +
      `var _=(n)=>new Array(n);var Lt=()=>{};` +
      `var Or=()=>({setStickyPrompt:(v)=>{published.push(v)}});` +
      source +
      `;var __cache=_(36);` +
      // One component instance, re-rendered: the memo cache persists across
      // renders exactly as the compiler's does.
      `function render(){let saved=_;_=()=>__cache;try{return km({scrollViewport:{handle,subscribe:()=>{}}})}finally{_=saved}}`,
    context
  );
  vm.runInContext("render()", context);
  context.sticky = false;
  context.scrollTop = 120;
  vm.runInContext("render()", context);
  return context.published;
}

test("frozen fixture reproduces the defect before patching", () => {
  const published = runComponent(memoizedFixture);
  // Second render happens after scrolling away, so the header should have been
  // published with an offset. The stale cache keeps reporting sticky.
  assert.deepEqual(published, [null, null], "unpatched memo should stay stuck on sticky");
});

test("forces every handle-keyed viewport read to re-evaluate", () => {
  const result = patchStickyPromptHeader(memoizedFixture);
  assert.equal(result.candidates, 3);
  assert.equal(result.patched, 3);
  assert.equal(evaluatePatchModule("sticky-prompt-header", result.content), null);

  const published = runComponent(result.content);
  assert.equal(published[0], null, "still sticky at mount");
  assert.equal(published[1], 120, "after scrolling, the header publishes the offset");
});

test("declines bundles whose viewport reads were never memoized", () => {
  const result = patchStickyPromptHeader(plainFixture);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.content, plainFixture);
  // The verifier must treat that as correct rather than as a missing patch.
  assert.equal(evaluatePatchModule("sticky-prompt-header", plainFixture), null);
});

// 2.1.267 no longer memoizes these reads, so a recent bundle can look exactly
// like a pre-2.1.247 one. (Measured: the handle-keyed memo of a viewport read
// occurs 3 times on 2.1.263 and 2.1.266 and 0 times on 2.1.267. Whether the
// enclosing component was deleted or rewritten was not established —
// `setStickyPrompt` still appears twice in both — so this says only what was
// measured.) The verifier used to waive on a version gate
// (">= 2.1.247 means the memo is present"), which cannot express "upstream took
// it away again" — it demanded three forced reads from a bundle with nothing to
// force and blocked the release.
test("waives a recent bundle whose viewport memo upstream removed", () => {
  const removed = plainFixture.replace("2.1.246", "2.1.267");
  assert.ok(removed.includes('VERSION:"2.1.267"'));

  const result = patchStickyPromptHeader(removed);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
  assert.equal(result.skipped, true);
  assert.equal(evaluatePatchModule("sticky-prompt-header", removed), null);
});

// The waiver keys off the bundle's shape, not its version, so it has to tell
// "removed" apart from "reshaped". A reshape is the dangerous one: the exact
// pattern misses, the header bug is back, and waiving on absence alone would
// ship it silently.
//
// Two reshapes, because they fail differently. Swapping the cache writes keeps
// the read spelled `ot.handle?.isSticky()`; hoisting the handle into a local
// changes the receiver itself, which the first version of this probe could not
// see — it required the receiver to end in `.handle`, so an aliased memo stayed
// frozen while both the patcher and the verifier reported success. That case is
// one the version gate this replaced would have caught, so the probe has to
// carry it rather than the claim being that shape checks dominate version ones.
for (const [name, reshaped] of [
  [
    "swapped cache writes",
    memoizedFixture.replace(
      "iS=ot.handle?.isSticky()??!0,Eo[2]=ot.handle,Eo[3]=iS;",
      "iS=ot.handle?.isSticky()??!0,Eo[3]=iS,Eo[2]=ot.handle;"
    ),
  ],
  [
    "handle hoisted into a local, guard still on the handle",
    memoizedFixture.replace(
      "let iS;if(Eo[2]!==ot.handle)iS=ot.handle?.isSticky()??!0,",
      "let hA=ot.handle,iS;if(Eo[2]!==ot.handle)iS=hA?.isSticky()??!0,"
    ),
  ],
  [
    // Both operands aliased. Broadening only the receiver left this one
    // invisible, which is the same silent-skip failure one step further in:
    // the guard has to be accepted in either spelling too.
    "handle hoisted for both the guard and the read",
    memoizedFixture.replace(
      "let iS;if(Eo[2]!==ot.handle)iS=ot.handle?.isSticky()??!0,Eo[2]=ot.handle,",
      "let hA=ot.handle,iS;if(Eo[2]!==hA)iS=hA?.isSticky()??!0,Eo[2]=hA,"
    ),
  ],
]) {
  test(`refuses a reshaped viewport memo instead of waiving on it: ${name}`, () => {
    assert.notEqual(reshaped, memoizedFixture, `${name} fixture did not change`);

    const result = patchStickyPromptHeader(reshaped);
    // Loud, not silent: non-zero candidates with zero patched fails
    // --assert-all and names this module, where `skipped: true` would have
    // passed the build.
    assert.equal(result.patched, 0);
    assert.notEqual(result.skipped, true);
    assert.ok(result.candidates > 0, `expected a reshaped memo to be seen, got ${result.candidates}`);
    assert.equal(result.content, reshaped);
    assert.notEqual(evaluatePatchModule("sticky-prompt-header", reshaped), null);
  });
}

// Both probe operands are bare identifiers, so without an ownership check any
// unrelated memo of an `isSticky`-shaped read counts as a reshaped sticky memo.
// That would report work outstanding on a bundle whose sticky reads are
// genuinely unmemoized — a false --assert-all failure on a healthy build, the
// same direction of harm that got the statement-boundary widening reverted.
//
// Both orderings, because the first version of the ownership test was a
// fixed-length forward slice from the function start. That runs past the
// matched function's closing brace, so an unrelated memo placed *before* the
// sticky component found its `setStickyPrompt` and was attributed to it —
// candidates 1, patched 0, no skip. The other ordering passed, which is why
// only testing one of them missed it.
const unrelatedMemo =
  "function toast(XE){let Eo=_(4),{state:st}=XE,v;if(Eo[2]!==st)v=st?.isSticky()??!0,Eo[2]=st,Eo[3]=v;else v=Eo[3];return v}";
for (const [order, unrelated] of [
  ["unrelated memo after the sticky component", `${plainFixture}\n${unrelatedMemo}\n`],
  ["unrelated memo before the sticky component", `${VERSION_METADATA}\n${unrelatedMemo}\n${plainFixture.split("\n").slice(1).join("\n")}`],
]) {
  test(`an unrelated component's memo does not count as a reshaped sticky memo: ${order}`, () => {
    const result = patchStickyPromptHeader(unrelated);
    // Still a skip: the sticky component's reads are unmemoized here.
    assert.equal(result.candidates, 0);
    assert.equal(result.patched, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.content, unrelated);
    assert.equal(evaluatePatchModule("sticky-prompt-header", unrelated), null);
  });
}

// The last way through the verifier, and the one that ships the bug rather
// than blocking a good build: three already-forced reads in an unrelated
// earlier function satisfy every check — count, kinds, shared cache and
// viewport locals — while the real sticky component carries an aliased memo
// that is still frozen. As a forward slice the final ownership test then ran
// past the unrelated function's closing brace and found the real component's
// `setStickyPrompt`, returning success.
test("verifier rejects forced reads that belong to another component", () => {
  const misowned = `${VERSION_METADATA}
function other(XE){let Eo=_(36),{scrollViewport:ot}=XE,iS;if(!0||Eo[2]!==ot.handle)iS=ot.handle?.isSticky()??!0,Eo[2]=ot.handle,Eo[3]=iS;else iS=Eo[3];let aS;if(!0||Eo[4]!==ot.handle)aS=ot.handle?.getScrollTop()??0,Eo[4]=ot.handle,Eo[5]=aS;else aS=Eo[5];let lS;if(!0||Eo[6]!==ot.handle)lS=ot.handle?.getPendingDelta()??0,Eo[6]=ot.handle,Eo[7]=lS;else lS=Eo[7];return iS}
function km(XE){let Fo=_(36),{scrollViewport:vp}=XE,{setStickyPrompt:dr}=Or(),hh=vp.handle,q;if(Fo[2]!==hh)q=hh?.isSticky()??!0,Fo[2]=hh,Fo[3]=q;else q=Fo[3];dr(q?null:1);return q}
`;
  assert.equal(
    evaluatePatchModule("sticky-prompt-header", misowned),
    "forced viewport reads are not inside the sticky-prompt component"
  );
});

// The nearest preceding `function ` is not necessarily the owner. A nested
// helper that already closed sits between the component's header and the
// match, and taking it as the owner yields an empty body — so a component this
// module patches correctly would report three candidates and zero patched, a
// false --assert-all failure on a healthy bundle.
test("finds the owning component past a closed nested helper", () => {
  const nested = `${VERSION_METADATA}
function km(XE){function helper(a){return a+1}let Eo=_(36),{scrollViewport:ot}=XE,{setStickyPrompt:dr}=Or();let iS;if(Eo[2]!==ot.handle)iS=ot.handle?.isSticky()??!0,Eo[2]=ot.handle,Eo[3]=iS;else iS=Eo[3];let aS;if(Eo[4]!==ot.handle)aS=ot.handle?.getScrollTop()??0,Eo[4]=ot.handle,Eo[5]=aS;else aS=Eo[5];let lS;if(Eo[6]!==ot.handle)lS=ot.handle?.getPendingDelta()??0,Eo[6]=ot.handle,Eo[7]=lS;else lS=Eo[7];dr(iS?null:helper(aS+lS));return iS}
`;
  const result = patchStickyPromptHeader(nested);
  assert.equal(result.candidates, 3);
  assert.equal(result.patched, 3);
  assert.equal(evaluatePatchModule("sticky-prompt-header", result.content), null);
});

// The walk back is floored at the enclosing Bun chunk, so a match owned by no
// function cannot drag the scan through the whole bundle.
test("a match owned by no function is skipped without scanning the bundle", () => {
  const noise = Array.from({ length: 4000 }, (_, i) => `function f${i}(a){return a}`).join("");
  const orphan = `${VERSION_METADATA}${noise}if(c[2]!==v.handle)x=v.handle?.isSticky()??!0;`;

  const started = Date.now();
  const result = patchStickyPromptHeader(orphan);
  const elapsed = Date.now() - started;

  assert.equal(result.candidates, 0);
  assert.equal(result.skipped, true);
  assert.ok(elapsed < 2000, `owner lookup took ${elapsed}ms; the walk back is not bounded`);
});

test("re-running the patch does not force a guard twice", () => {
  const once = patchStickyPromptHeader(memoizedFixture).content;
  const twice = patchStickyPromptHeader(once);
  assert.equal(twice.candidates, 0);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once);
});

test("refuses reads that do not belong to one sticky-prompt component", () => {
  // Same memo shape, but the owning function does not publish a sticky prompt.
  const notSticky = memoizedFixture.replace("{setStickyPrompt:dr}=Or()", "{setSomethingElse:dr}=Or()");
  assert.notEqual(notSticky, memoizedFixture);
  const result = patchStickyPromptHeader(notSticky);
  assert.equal(result.candidates, 3);
  assert.equal(result.patched, 0, "three reads alone are a compiler idiom, not this component");

  // And a bundle where the three reads are split across two caches.
  const splitCache = memoizedFixture.replace("Eo[6]!==ot.handle", "Fo[6]!==ot.handle");
  assert.notEqual(splitCache, memoizedFixture);
  assert.equal(patchStickyPromptHeader(splitCache).patched, 0);
});

test("verifier rejects a bundle whose reads are still frozen", () => {
  assert.notEqual(
    evaluatePatchModule("sticky-prompt-header", memoizedFixture),
    null,
    "an unpatched 2.1.247+ bundle must not verify clean"
  );
});
