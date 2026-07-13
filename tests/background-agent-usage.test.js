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

function runtime(source = fixture) {
  const result = patchBackgroundAgentUsage(source);
  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  const context = { Y0u: 5, Th: "Task", Oy: "REPL", ZAt: () => undefined };
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
    /pQn\(trackerRecord,eventRecord,activityContext,contentItem\.options\.tools\),__calicoRefreshAgentUsage\(trackerRecord,transcriptEntries\)/
  );
  assert.match(
    result.content,
    /__calicoRefreshAgentUsage\(trackerRecord,resultMessage\),i9u\(trackerState,l3r\(trackerRecord\),toolInput\)/
  );

  const tracker = context.uQn();
  context.pQn(tracker, assistant("renamed", { input_tokens: 17, output_tokens: 4 }));
  assert.equal(context.dQn(tracker), 21);
});

test("binary verifier rejects empty helpers hidden behind dead exact markers", () => {
  const patched = patchBackgroundAgentUsage(fixture).content;
  assert.equal(evaluatePatchModule("background-agent-usage", patched), null);

  const trackHelper = patched.match(
    /function __calicoTrackAgentUsage[\s\S]*?(?=function __calicoRefreshAgentUsage)/
  )?.[0];
  const refreshHelper = patched.match(
    /function __calicoRefreshAgentUsage[\s\S]*?(?=function fQn\()/
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
