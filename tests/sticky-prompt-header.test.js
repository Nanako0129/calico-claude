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
