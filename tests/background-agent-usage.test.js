const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchBackgroundAgentUsage,
} = require("../patch-claude-display.ts");
const {
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const fixture = `
function fQn(){return{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0,recentActivities:[]}}
function mQn(e){return e.latestInputTokens+e.cumulativeOutputTokens}
function hQn(e,t,r,n){if(t.type==="progress"&&t.data.type==="repl_tool_call"&&t.data.phase==="start"){let{toolName:i,toolInput:s}=t.data,a=n?ZAt(i,s,n):void 0;if(e.recentActivities.push({toolName:i,input:s,activityDescription:r?.(i,s),isSearch:a?.isSearch,isRead:a?.isRead}),e.recentActivities.length>Y0u)e.recentActivities.shift();return}if(t.type!=="assistant")return;let o=t.message.usage;e.latestInputTokens=o.input_tokens+(o.cache_creation_input_tokens??0)+(o.cache_read_input_tokens??0),e.cumulativeOutputTokens+=o.output_tokens;for(let i of t.message.content){if(i.type!=="tool_use")continue;if(e.toolUseCount++,i.name===Th)continue;if(i.name===Oy)continue;let s=i.input,a=n?ZAt(i.name,s,n):void 0;e.recentActivities.push({toolName:i.name,input:s,activityDescription:r?.(i.name,s),isSearch:a?.isSearch,isRead:a?.isRead})}while(e.recentActivities.length>Y0u)e.recentActivities.shift()}
function a9r(e){return{toolUseCount:e.toolUseCount,tokenCount:mQn(e),lastActivity:e.recentActivities.at(-1),recentActivities:[...e.recentActivities]}}
function asyncLoopFixture(){hQn(re,_e,ie,i.options.tools),Z0u(e,a9r(re),s);let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});if(tRu(de,s))return}
`;

function renameToken(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&");
  return source.replace(
    new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g"),
    to
  );
}

function modelsUsedFixture(source = fixture) {
  return source.replace(
    "let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});",
    "let oe=RTy(s,e,g),de=fCs(oe,e,{...n,modelsUsed:_},{suppressTelemetry:ee});"
  );
}

// 2.1.267 appended `handback` and `handbackInterim` to the options object.
// Pinning the closing brace straight after `suppressTelemetry:<ident>` took
// this module from four candidates to three and zero patched, which blocked the
// 2.1.267 release — every downstream anchor is built from this one match.
function handbackFixture(source = fixture) {
  return source.replace(
    "let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});",
    "let oe=RTy(s,e,g),de=fCs(oe,e,{...n,modelsUsed:_},{suppressTelemetry:ee,handback:ha?void 0:V9(y.get(e),e),handbackInterim:ee});"
  );
}

function renamedFixture() {
  const renames = [
    ["fQn", "uQn"],
    ["mQn", "dQn"],
    ["hQn", "pQn"],
    ["a9r", "l3r"],
    ["Z0u", "i9u"],
    ["RTy", "ZTy"],
    ["fCs", "xCs"],
    ["tRu", "wRu"],
    ["e", "trackerState"],
    ["t", "eventFrame"],
    ["r", "activityFormatter"],
    ["n", "requestContext"],
    ["o", "usageFrame"],
    ["i", "contentItem"],
    ["s", "toolInput"],
    ["re", "trackerRecord"],
    ["_e", "eventRecord"],
    ["ie", "activityContext"],
    ["g", "transcriptEntries"],
    ["oe", "resultMessage"],
    ["de", "completionStatus"],
    ["ee", "suppressTelemetry"],
  ];
  return renames.reduce((source, [from, to]) => renameToken(source, from, to), fixture);
}

// 2.1.273 stopped reading the usage object straight off the message. It routes
// it through a shape screen and guards the accounting block on the verdict:
//
//   2.1.272  let d=t.message.usage;e.latestInputTokens=…
//   2.1.273  let d=mQ(t.message.usage);if(d){e.latestInputTokens=…}
//
// Measured from the 2.1.273 macos-arm64 bundle, `mQ` is
//
//   function mQ(e){if(e==null||typeof e.input_tokens!=="number")return;
//     if(typeof e.output_tokens==="number")return e;
//     return e.output_tokens==null?{...e,output_tokens:0}:void 0}
//
// so it returns the object, fills a missing output_tokens with 0, or returns
// undefined. It changes no figure it passes through — what it decides is
// whether the block runs at all.
function normalizedFixture(source = fixture) {
  return source
    .replace(
      "let o=t.message.usage;e.latestInputTokens=",
      "let o=nrm(t.message.usage);if(o){e.latestInputTokens="
    )
    .replace(
      "while(e.recentActivities.length>Y0u)e.recentActivities.shift()}",
      "while(e.recentActivities.length>Y0u)e.recentActivities.shift()}}"
    );
}

// The same admission rule `mQ` implements: a usable shape passes through, an
// unusable one is rejected. Nothing about the figures changes, which is the
// point — what the guard decides is whether the block behind it runs.
const screen = (usage) =>
  usage == null || typeof usage.input_tokens !== "number"
    ? undefined
    : typeof usage.output_tokens === "number"
      ? usage
      : usage.output_tokens == null
        ? { ...usage, output_tokens: 0 }
        : undefined;

function runtime(source = fixture) {
  const result = patchBackgroundAgentUsage(source);
  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  const context = {
    Y0u: 5,
    Th: "Task",
    Oy: "REPL",
    ZAt: () => undefined,
    nrm: screen,
  };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  return { context, result };
}

function stream(type, fields = {}) {
  return { type: "stream_event", event: { type, ...fields } };
}

function assistant(id, usage, stopReason = null, content = []) {
  return {
    type: "assistant",
    message: { id, usage, stop_reason: stopReason, content },
  };
}

test("accounts GPT usage delivered after a provisional 0/0 wrapper", () => {
  const { context } = runtime();
  const tracker = context.fQn();

  context.hQn(
    tracker,
    stream("message_start", {
      message: { id: "resp-a", usage: { input_tokens: 0, output_tokens: 0 } },
    })
  );
  context.hQn(tracker, assistant("resp-a", { input_tokens: 0, output_tokens: 0 }));
  assert.equal(context.mQn(tracker), 0);

  context.hQn(
    tracker,
    stream("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 300,
        output_tokens: 40,
      },
    })
  );

  assert.equal(tracker.latestInputTokens, 420);
  assert.equal(tracker.cumulativeOutputTokens, 40);
  assert.equal(context.a9r(tracker).tokenCount, 460);
});

test("preserves native message_start input and adds terminal output", () => {
  const { context } = runtime();
  const tracker = context.fQn();

  context.hQn(
    tracker,
    stream("message_start", {
      message: {
        id: "msg-native",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 180,
          output_tokens: 0,
        },
      },
    })
  );
  context.hQn(tracker, assistant("msg-native", { input_tokens: 0, output_tokens: 0 }));
  context.hQn(
    tracker,
    stream("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 30 },
    })
  );

  assert.equal(tracker.latestInputTokens, 300);
  assert.equal(tracker.cumulativeOutputTokens, 30);
  assert.equal(context.mQn(tracker), 330);
});

test("deduplicates cumulative output across wrappers and repeated deltas", () => {
  const { context } = runtime();
  const tracker = context.fQn();

  context.hQn(
    tracker,
    stream("message_start", {
      message: { id: "resp-a", usage: { input_tokens: 0, output_tokens: 0 } },
    })
  );
  context.hQn(tracker, assistant("resp-a", { input_tokens: 0, output_tokens: 0 }));
  context.hQn(tracker, assistant("resp-a", { input_tokens: 0, output_tokens: 0 }));
  const terminal = stream("message_delta", {
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 90, output_tokens: 12 },
  });
  context.hQn(tracker, terminal);
  context.hQn(tracker, terminal);
  context.hQn(tracker, assistant("resp-a", { input_tokens: 90, output_tokens: 12 }, "end_turn"));

  assert.equal(tracker.latestInputTokens, 90);
  assert.equal(tracker.cumulativeOutputTokens, 12);
  assert.equal(context.mQn(tracker), 102);
});

test("uses latest input plus cumulative output across agent turns", () => {
  const { context } = runtime();
  const tracker = context.fQn();

  for (const [id, input, cache, output] of [
    ["resp-a", 100, 20, 10],
    ["resp-b", 200, 50, 20],
  ]) {
    context.hQn(
      tracker,
      stream("message_start", {
        message: { id, usage: { input_tokens: 0, output_tokens: 0 } },
      })
    );
    context.hQn(tracker, assistant(id, { input_tokens: 0, output_tokens: 0 }));
    context.hQn(
      tracker,
      stream("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: input,
          cache_read_input_tokens: cache,
          output_tokens: output,
        },
      })
    );
    context.hQn(tracker, stream("message_stop"));
  }

  assert.equal(tracker.latestInputTokens, 250);
  assert.equal(tracker.cumulativeOutputTokens, 30);
  assert.equal(context.mQn(tracker), 280);
  assert.equal(tracker.activeMessageId, null);
});

test("still accounts a direct completed assistant without stream frames", () => {
  const { context } = runtime();
  const tracker = context.fQn();
  context.hQn(
    tracker,
    assistant(
      "direct-a",
      { input_tokens: 75, cache_read_input_tokens: 25, output_tokens: 8 },
      "end_turn"
    )
  );
  assert.equal(context.mQn(tracker), 108);
});

test("refreshes finalized usage from a wrapper mutated after it was first sampled", () => {
  const { context } = runtime();
  const tracker = context.fQn();
  const response = assistant("late-a", { input_tokens: 0, output_tokens: 0 });
  const messages = [response];

  context.hQn(tracker, response);
  assert.equal(context.mQn(tracker), 0);

  response.message.usage = {
    input_tokens: 140,
    cache_read_input_tokens: 60,
    output_tokens: 15,
  };
  response.message.stop_reason = "tool_use";
  messages.push({ type: "user", message: { content: [] } });
  context.__calicoRefreshAgentUsage(tracker, messages);

  assert.equal(tracker.latestInputTokens, 200);
  assert.equal(tracker.cumulativeOutputTokens, 15);
  assert.equal(context.mQn(tracker), 215);
});

test("matches renamed function, parameter, and seam locals", () => {
  const renamed = renamedFixture();
  const { context, result } = runtime(renamed);

  assert.match(result.content, /function uQn\(\)\{return\{toolUseCount:0/);
  assert.match(
    result.content,
    /pQn\(trackerRecord,eventRecord,activityContext,contentItem\.options\.tools\),globalThis\.__calicoRefreshAgentUsage\(trackerRecord,transcriptEntries\)/
  );
  assert.match(
    result.content,
    /globalThis\.__calicoRefreshAgentUsage\(trackerRecord,resultMessage\),i9u\(trackerState,l3r\(trackerRecord\),toolInput\)/
  );

  const tracker = context.uQn();
  context.pQn(tracker, assistant("renamed", { input_tokens: 17, output_tokens: 4 }));
  assert.equal(context.dQn(tracker), 21);
});

test("accepts the 2.1.267 handback fields on the completion options object", () => {
  const source = handbackFixture();
  const result = patchBackgroundAgentUsage(source);

  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  // The options object is re-emitted verbatim, so the new fields survive.
  assert.match(
    result.content,
    /\{suppressTelemetry:ee,handback:ha\?void 0:V9\(y\.get\(e\),e\),handbackInterim:ee\}\);globalThis\.__calicoRefreshAgentUsage\(re,oe\),Z0u\(e,a9r\(re\),s\);/
  );
  assert.equal(evaluatePatchModule("background-agent-usage", result.content), null);
});

test("accepts the 2.1.212 modelsUsed completion variant without changing metadata", () => {
  const source = modelsUsedFixture();
  const result = patchBackgroundAgentUsage(source);

  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  assert.match(
    result.content,
    /de=fCs\(oe,e,\{\.\.\.n,modelsUsed:_\},\{suppressTelemetry:ee\}\);globalThis\.__calicoRefreshAgentUsage\(re,oe\),Z0u\(e,a9r\(re\),s\);/
  );
  assert.equal(evaluatePatchModule("background-agent-usage", result.content), null);
  const wrongTranscriptRefresh = result.content.replace(
    "globalThis.__calicoRefreshAgentUsage(re,g)",
    "globalThis.__calicoRefreshAgentUsage(re,otherTranscript)"
  );
  assert.notEqual(wrongTranscriptRefresh, result.content);
  assert.notEqual(
    evaluatePatchModule("background-agent-usage", wrongTranscriptRefresh),
    null
  );
});

test("modelsUsed completion keeps one owner, status, transcript, and semantic role", () => {
  const source = modelsUsedFixture();
  const progress = "hQn(re,_e,ie,i.options.tools),Z0u(e,a9r(re),s);";
  const completion =
    "let oe=RTy(s,e,g),de=fCs(oe,e,{...n,modelsUsed:_},{suppressTelemetry:ee});";
  const splitFunctions = source.replace(
    `function asyncLoopFixture(){${progress}${completion}if(tRu(de,s))return}`,
    `function progressFixture(){${progress}}function completionFixture(){${completion}if(tRu(de,s))return}`
  );
  const brokenFixtures = [
    source.replace("RTy(s,e,g)", "RTy(otherStatus,e,g)"),
    source.replace("RTy(s,e,g)", "RTy(s,otherOwner,g)"),
    source.replace(completion, `queueMicrotask(()=>{${completion}});`),
    source.replace(
      completion,
      `${completion}let ox=RTy(s,e,g),dx=fCs(ox,e,n,{suppressTelemetry:ee});`
    ),
    splitFunctions,
  ];

  for (const broken of brokenFixtures) {
    const result = patchBackgroundAgentUsage(broken);
    assert.notEqual(broken, source);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
  }
});

test("binary verifier rejects empty helpers hidden behind dead exact markers", () => {
  const patched = patchBackgroundAgentUsage(fixture).content;
  assert.equal(evaluatePatchModule("background-agent-usage", patched), null);

  const trackHelper = patched.match(
    /function __calicoTrackAgentUsage[\s\S]*?(?=function __calicoRefreshAgentUsage)/
  )?.[0];
  const refreshHelper = patched.match(
    /function __calicoRefreshAgentUsage[\s\S]*?(?=globalThis\.__calicoRefreshAgentUsage=)/
  )?.[0];
  assert.ok(trackHelper);
  assert.ok(refreshHelper);

  const emptyTrack = patched.replace(
    trackHelper,
    `var __calicoTrackAgentUsage=()=>{};/*${trackHelper}*/`
  );
  const emptyRefresh = patched.replace(
    refreshHelper,
    `var __calicoRefreshAgentUsage=()=>{};/*${refreshHelper}*/`
  );
  const helperBlock = trackHelper + refreshHelper;
  const destructuredHelpers = patched.replace(
    helperBlock,
    `var {__calicoTrackAgentUsage,__calicoRefreshAgentUsage}={__calicoTrackAgentUsage:()=>{},__calicoRefreshAgentUsage:()=>{}};/*${helperBlock}*/`
  );
  const commentOnlyHelpers = patched.replace(helperBlock, `/*${helperBlock}*/`);

  assert.notEqual(evaluatePatchModule("background-agent-usage", emptyTrack), null);
  assert.notEqual(evaluatePatchModule("background-agent-usage", emptyRefresh), null);
  assert.notEqual(
    evaluatePatchModule("background-agent-usage", destructuredHelpers),
    null
  );
  assert.notEqual(
    evaluatePatchModule("background-agent-usage", commentOnlyHelpers),
    null
  );
});

test("fails atomically when either native anchor is missing", () => {
  for (const broken of [
    fixture.replace("toolUseCount:0", "toolUseCount:1"),
    fixture.replace('if(t.type!=="assistant")return;', 'if(t.type!=="assistant")break_here;'),
  ]) {
    const result = patchBackgroundAgentUsage(broken);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
    assert.equal(result.content.includes("__calicoTrackAgentUsage"), false);
  }
});

test("fails atomically when progress and completion seams disagree", () => {
  for (const broken of [
    fixture.replace("let oe=RTy(s,e,g)", "let oe=RTy(other,e,g)"),
    fixture.replace("let oe=RTy(s,e,g)", "let oe=RTy(s,other,g)"),
  ]) {
    const result = patchBackgroundAgentUsage(broken);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
    assert.equal(result.content.includes("__calicoTrackAgentUsage"), false);
  }
});

test("fails atomically when completion is deferred into an arrow callback", () => {
  const deferred = fixture.replace(
    "let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});",
    "queueMicrotask(()=>{let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});});"
  );
  const result = patchBackgroundAgentUsage(deferred);

  assert.equal(result.patched, 0);
  assert.equal(result.content, deferred);
  assert.equal(result.content.includes("__calicoTrackAgentUsage"), false);
});

test("fails atomically when progress and completion matches come from different functions", () => {
  const split = fixture.replace(
    "function asyncLoopFixture(){hQn(re,_e,ie,i.options.tools),Z0u(e,a9r(re),s);let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});if(tRu(de,s))return}",
    "function progressFixture(){hQn(re,_e,ie,i.options.tools),Z0u(e,a9r(re),s)}function completionFixture(){let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});if(tRu(de,s))return}"
  );
  const result = patchBackgroundAgentUsage(split);

  assert.equal(result.patched, 0);
  assert.equal(result.content, split);
  assert.equal(result.content.includes("__calicoTrackAgentUsage"), false);
});

// 2.1.273: the usage read is normalised and guarded. The module has to accept
// the new spelling — missing it zeroes the module and blocks the release, which
// is what happened on the first 2.1.273 preflight.
test("patches the 2.1.273 normalised usage read", () => {
  const source = normalizedFixture();
  const result = patchBackgroundAgentUsage(source);

  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  assert.equal(evaluatePatchModule("background-agent-usage", result.content), null);
});

// Re-emitting the matched initialiser rather than rebuilding it is what keeps
// upstream's guard reading upstream's verdict. A rebuilt `let o=t.message.usage`
// makes `if(o)` test the raw object instead, so a shape upstream screened out
// would still run the block it put behind that guard — with every calico marker
// present. Only the guarded block can show the difference: this usage is truthy
// but fails the screen.
test("the guard keeps testing the screen's verdict, not the raw object", () => {
  const { context } = runtime(normalizedFixture());
  const tracker = context.fQn();

  context.hQn(
    tracker,
    assistant(
      "resp-unusable",
      // input_tokens present, output_tokens neither a number nor null — the
      // one shape `mQ` rejects outright while the object itself is truthy.
      { input_tokens: 400, output_tokens: "many" },
      "end_turn",
      [{ type: "tool_use", name: "Read", input: {} }]
    )
  );

  // toolUseCount lives inside the guard upstream opened, so a rebuilt
  // initialiser would count this one.
  assert.equal(tracker.toolUseCount, 0);
});

// Two call sites write this tracker: the event path here, and the
// __calicoRefreshAgentUsage sweep the progress and completion sites run over
// the transcript. The sweep can only reach the raw `message.usage` — the
// screen's verdict is not recorded on the message — so the event path must
// admit on the same terms, or the same response is counted or skipped
// depending on which path saw it last.
test("tracks the same usage the transcript sweep will see", () => {
  const { context } = runtime(normalizedFixture());

  const message = assistant(
    "resp-shared",
    { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 90 },
    "end_turn"
  );

  const viaEvent = context.fQn();
  context.hQn(viaEvent, message);

  const viaSweep = context.fQn();
  context.__calicoRefreshAgentUsage(viaSweep, [message]);

  assert.equal(context.mQn(viaEvent), 490);
  assert.equal(context.mQn(viaSweep), context.mQn(viaEvent));
});

// The guard the patcher re-emits has to keep guarding: a message whose usage
// the screen rejects must account nothing and must not run the block upstream
// put inside the guard.
test("preserves the null guard around the accounting block", () => {
  const { context } = runtime(normalizedFixture());
  const tracker = context.fQn();

  context.hQn(
    tracker,
    assistant("resp-null", null, "end_turn", [{ type: "tool_use", name: "Read", input: {} }])
  );

  assert.equal(context.mQn(tracker), 0);
  // toolUseCount lives inside the guard upstream opened, so it must not run.
  assert.equal(tracker.toolUseCount, 0);
});

// Paired, not crossed: the guard belongs to the normalised spelling. A bundle
// that wraps the read but keeps the accounting unguarded is a shape the patcher
// cannot re-emit correctly, so it must report zero rather than emit a stray
// brace.
test("rejects a normalised read without its guard", () => {
  const broken = fixture.replace(
    "let o=t.message.usage;e.latestInputTokens=",
    "let o=nrm(t.message.usage);e.latestInputTokens="
  );
  const result = patchBackgroundAgentUsage(broken);

  assert.equal(result.patched, 0);
  assert.equal(result.content, broken);
  assert.equal(result.content.includes("__calicoTrackAgentUsage"), false);
});

// The sweep is declared beside the tracker factory but called from the progress
// and completion sites. Through 2.1.273 those shared a Bun chunk, so a bare
// name resolved; 2.1.274 split them, and a chunk is a separate ES module scope.
// native-bun's module-scope guard caught it and refused the build rather than
// shipping a binary whose background-agent progress path throws on every call.
//
// Every call therefore goes through globalThis. A bare call would pass every
// count and marker check in this file — it only fails at build time, on a
// bundle whose chunk split nothing here reproduces — so the shape is asserted
// directly.
test("reaches the transcript sweep through globalThis, never a bare name", () => {
  const { content } = patchBackgroundAgentUsage(fixture);

  // One declaration, and one publish naming it on both sides.
  assert.equal(
    content.split("function __calicoRefreshAgentUsage").length - 1,
    1
  );
  assert.equal(
    content.split("globalThis.__calicoRefreshAgentUsage=__calicoRefreshAgentUsage;").length - 1,
    1
  );

  // No call site reaches it by bare name. `(?<![.\w$])` is what native-bun's
  // guard uses to decide a reference is unqualified; `(?<!function )` drops
  // the declaration, which is the one bare occurrence that must stay.
  const bareCalls = [
    ...content.matchAll(/(?<![.\w$])(?<!function )__calicoRefreshAgentUsage\s*\(/g),
  ];
  assert.deepEqual(bareCalls.map((m) => m[0]), []);

  // And the two qualified call sites are present.
  assert.equal(
    content.split("globalThis.__calicoRefreshAgentUsage(").length - 1,
    2
  );
});

// 2.1.282 skips the screen for provisional wrappers, which it now marks
// `isUnmetered` until the authoritative usage is copied in:
//
//   let g=n.isUnmetered===!0?void 0:wte(n.message.usage);if(g){…
//
// The initialiser is re-emitted verbatim, so upstream's guard keeps its
// verdict: an unmetered wrapper runs nothing upstream put behind the guard.
function unmeteredFixture() {
  return normalizedFixture().replace(
    "let o=nrm(t.message.usage);",
    "let o=t.isUnmetered===!0?void 0:nrm(t.message.usage);"
  );
}

test("patches the 2.1.282 unmetered-screened usage read", () => {
  const source = unmeteredFixture();
  assert.notEqual(source, normalizedFixture());
  const result = patchBackgroundAgentUsage(source);

  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  assert.equal(evaluatePatchModule("background-agent-usage", result.content), null);
});

test("an unmetered wrapper runs nothing behind upstream's guard", () => {
  const { context } = runtime(unmeteredFixture());
  const tool = [{ type: "tool_use", name: "Read", input: {} }];
  const usage = { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 90 };

  const unmetered = context.fQn();
  context.hQn(unmetered, { ...assistant("resp-provisional", usage, null, tool), isUnmetered: true });
  assert.equal(unmetered.toolUseCount, 0);

  const metered = context.fQn();
  context.hQn(metered, assistant("resp-final", usage, "end_turn", tool));
  assert.equal(metered.toolUseCount, 1);
  assert.equal(context.mQn(metered), 490);
});
