const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchBackgroundAgentUsage,
} = require("../patch-claude-display.ts");

const fixture = `
function fQn(){return{toolUseCount:0,latestInputTokens:0,cumulativeOutputTokens:0,recentActivities:[]}}
function mQn(e){return e.latestInputTokens+e.cumulativeOutputTokens}
function hQn(e,t,r,n){if(t.type==="progress"&&t.data.type==="repl_tool_call"&&t.data.phase==="start"){let{toolName:i,toolInput:s}=t.data,a=n?ZAt(i,s,n):void 0;if(e.recentActivities.push({toolName:i,input:s,activityDescription:r?.(i,s),isSearch:a?.isSearch,isRead:a?.isRead}),e.recentActivities.length>Y0u)e.recentActivities.shift();return}if(t.type!=="assistant")return;let o=t.message.usage;e.latestInputTokens=o.input_tokens+(o.cache_creation_input_tokens??0)+(o.cache_read_input_tokens??0),e.cumulativeOutputTokens+=o.output_tokens;for(let i of t.message.content){if(i.type!=="tool_use")continue;if(e.toolUseCount++,i.name===Th)continue;if(i.name===Oy)continue;let s=i.input,a=n?ZAt(i.name,s,n):void 0;e.recentActivities.push({toolName:i.name,input:s,activityDescription:r?.(i.name,s),isSearch:a?.isSearch,isRead:a?.isRead})}while(e.recentActivities.length>Y0u)e.recentActivities.shift()}
function a9r(e){return{toolUseCount:e.toolUseCount,tokenCount:mQn(e),lastActivity:e.recentActivities.at(-1),recentActivities:[...e.recentActivities]}}
function asyncLoopFixture(){hQn(re,_e,ie,i.options.tools),Z0u(e,a9r(re),s);let oe=RTy(s,e,g),de=fCs(oe,e,n,{suppressTelemetry:ee});if(tRu(de,s))return}
`;

function runtime() {
  const result = patchBackgroundAgentUsage(fixture);
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

test("fails atomically when either native anchor is missing", () => {
  for (const broken of [
    fixture.replace("function fQn()", "function changedTracker()"),
    fixture.replace('if(t.type!=="assistant")return;', 'if(t.type!=="assistant")break_here;'),
  ]) {
    const result = patchBackgroundAgentUsage(broken);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
    assert.equal(result.content.includes("__calicoTrackAgentUsage"), false);
  }
});
