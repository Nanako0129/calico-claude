const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchCustomContextWindows,
  patchStatuslineCommittedUsage,
} = require("../patch-claude-display.ts");
const {
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const committedUsageFixture = `
function ZJr(e){return e}
function OG(){return {}}
var sar={randomUUID:()=>"uuid"};
function makeAssistant(usage,stopReason,content){return{id:"m",model:"model",usage,stop_reason:stopReason,content:content||[]}}
function xAe(previous,delta){let r=delta?.cache_creation,n=(r?.ephemeral_1h_input_tokens??0)+(r?.ephemeral_5m_input_tokens??0);return{input_tokens:delta?.input_tokens!==null&&delta?.input_tokens>0?delta.input_tokens:previous?.input_tokens??0,output_tokens:delta?.output_tokens??previous?.output_tokens??0,cache_creation_input_tokens:delta?.cache_creation_input_tokens!==null&&delta?.cache_creation_input_tokens>0?delta.cache_creation_input_tokens:n>0?n:previous?.cache_creation_input_tokens??0,cache_read_input_tokens:delta?.cache_read_input_tokens!==null&&delta?.cache_read_input_tokens>0?delta.cache_read_input_tokens:previous?.cache_read_input_tokens??0}}
function cloneDownstream(an,base,clone){let eo=[],lo=base,Gi=base;if(clone)lo={...base,message:{...base.message,content:[...base.message.content]}},eo.push({src:an.message,dst:lo.message}),Gi={...base,message:{...base.message,content:[...base.message.content]}},eo.push({src:an.message,dst:Gi.message});if(an.type==="stream_event"&&an.event.type==="message_delta"){for(let{src:_i,dst:Ii}of eo)Ii.usage=_i.usage,Ii.stop_reason=_i.stop_reason,Ii.stop_details=_i.stop_details;}return[lo,Gi]}
function query(messageStartUsage,stopReason,commit,rawTerminalUsage,clone,copyForState,terminalEvents){let wo=makeAssistant(messageStartUsage,null),Zr={type:"text",text:""},n={},i={agentId:"a"},_r=[],pn=wo.usage,Se=stopReason,ar={usage:rawTerminalUsage??messageStartUsage,delta:{stop_details:null}},ge=null,_=null;let Kn={message:{...wo,content:ZJr([Zr],n,i.agentId,{requestId:ge??void 0,messageId:wo.id})},requestId:ge??void 0,...OG(i.querySource,i.spawnedBySkill,i.activeSkill,i.activeMcpServer,i.activeMcpTool),type:"assistant",uuid:sar.randomUUID(),timestamp:new Date().toISOString(),...!1,..._&&{advisorModel:_}};_r.push(Kn);let stateCopy=copyForState?{...Kn}:null;if(commit!==!1){for(let event of terminalEvents??[{usage:ar.usage,stopReason:Se}]){ar={usage:event.usage,delta:{stop_details:null}},Se=event.stopReason;switch("message_delta"){case"message_delta":{pn=xAe(pn,ar.usage);for(let Ou of _r)Ou.message.usage=pn,Ou.message.stop_reason=Se,Ou.message.stop_details=ar.delta.stop_details??null;break}}}}let cloneResult=cloneDownstream({...Kn,type:"stream_event",event:{type:"message_delta"}},Kn,clone);return copyForState?[stateCopy]:clone?cloneResult:_r}
function LCe(e){if(e?.type==="assistant"&&"usage"in e.message&&e.message.model!=="internal")return e.message.usage;return}
function aJt(e){for(let t=e.length-1;t>=0;t--){let r=e[t],n=r?LCe(r):void 0;if(n)return{input_tokens:n.input_tokens,output_tokens:n.output_tokens,cache_creation_input_tokens:n.cache_creation_input_tokens??0,cache_read_input_tokens:n.cache_read_input_tokens??0}}return null}
function pK_(e,t){return{current_usage:e,context_window_size:t}}
function MB(){}function Iy(){}function RF(){return"model"}function sw(){return 200000}function UE(){}
function fK_(e,t,r,n,o,i,s,a,l,c,u,d,p,f){let m=MB(),g=Iy(),y=RF({permissionMode:e,mainLoopModel:s,exceeds200kTokens:t}),_=n?.outputStyle||"default",S=aJt(o),b=sw(y,UE());return{context_window:pK_(S,b)}}
`;

function renameToken(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&");
  return source.replace(
    new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g"),
    to
  );
}

function effortCommittedUsageFixture(source = committedUsageFixture) {
  return source
    .replace("ge=null,_=null;let Kn=", 'ge=null,_=null,Ie="high";let Kn=')
    .replace(
      "..._&&{advisorModel:_}};",
      "..._&&{advisorModel:_},...Ie!==void 0&&{effort:Ie}};"
    );
}

function batchCommittedUsageFixture(source = committedUsageFixture) {
  return effortCommittedUsageFixture(source)
    .replace(
      "function ZJr(e){return e}",
      "function ZJr(e){return e}\nfunction K4i(e,t){return{content:e,batchToolUses:[]}}"
    )
    .replace(
      "let Kn={message:{...wo,content:ZJr([Zr],n,i.agentId,{requestId:ge??void 0,messageId:wo.id})},requestId:ge??void 0,",
      "let{content:Ct,batchToolUses:Bt}=K4i(ZJr([Zr],n,i.agentId,{requestId:ge??void 0,messageId:wo.id}),n),Kn={message:{...wo,content:Ct},...Bt.length>0&&{batchToolUses:Bt},requestId:ge??void 0,"
    );
}

function storageV5BatchFixture(source = committedUsageFixture) {
  // 2.1.238 appends a fifth argument (the storage V5 handle) to the content
  // builder call inside the batch wrapper:
  // `ZJr([Zr],n,i.agentId,{...,messageId:wo.id},i.storageV5)`.
  return batchCommittedUsageFixture(source).replace(
    ",messageId:wo.id}),n),Kn=",
    ",messageId:wo.id},i.storageV5),n),Kn="
  );
}

const modelsUsedCompletionSignal =
  "function backgroundCompletionSignal(){let ie=BBg(s,e,g),de=Yns(ie,e,{...n,modelsUsed:_},{suppressTelemetry:re});__calicoRefreshAgentUsage(re,ie),Z0u(e,a9r(re),s);return de}";

function renamedCommittedUsageFixture() {
  const renames = [
    ["ZJr", "buildContent"],
    ["OG", "buildMetadata"],
    ["sar", "uuidNamespace"],
    ["xAe", "aggregateUsage"],
    ["aJt", "usageReducer"],
    ["pK_", "usagePayload"],
    ["sw", "contextWindow"],
    ["UE", "windowOptions"],
    ["Kn", "assistantWrapper"],
    ["wo", "baseMessage"],
    ["Zr", "contentBlock"],
    ["n", "renderContext"],
    ["i", "agentContext"],
    ["ge", "requestId"],
    ["_", "advisorModel"],
    ["_r", "assistantEntries"],
    ["eo", "clonePairs"],
    ["pn", "aggregatedUsage"],
    ["Se", "terminalStop"],
    ["ar", "terminalEvent"],
    ["Ou", "assistantEntry"],
    ["_i", "cloneSource"],
    ["Ii", "cloneDestination"],
    ["an", "originalWrapper"],
    ["lo", "firstClone"],
    ["Gi", "secondClone"],
    ["S", "selectedUsage"],
    ["b", "windowSize"],
    ["o", "messageEntries"],
    ["y", "modelContext"],
  ];
  return renames.reduce((source, [from, to]) => renameToken(source, from, to), committedUsageFixture);
}

const customContextFixture = `
function resolve(e,t){if(check(e))return 1e6;if(t?.includes("model"))return 200000;return 200000}
function effective(e,t){let r=Math.min(resolve(e),t),n=precomputeGate()?t:void 0,{window:o}=derive(e,n);return o-r}
function precompute(e,t){return Math.min(e-Math.round(e*t.precomputeBufferFraction),effective(e,t))}
function status(contextFn,usage,windowValue){return{context_window:contextFn(usage,windowValue),exceeds_200k_tokens:!1}}
function check(e){return false}function precomputeGate(){return false}function derive(e,n){return{window:e}}
`;

function usage(input, output, cacheCreation = 0, cacheRead = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

function loadCommittedFixture(source = committedUsageFixture) {
  const result = patchStatuslineCommittedUsage(source);
  assert.equal(result.candidates, 6);
  assert.equal(result.patched, 6);

  const context = { process: { env: {} } };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  return { context, result };
}

function readStatuslineUsage(context, messages) {
  const value = context.fK_(
    null,
    false,
    null,
    null,
    messages,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null
  ).context_window.current_usage;
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

test("first provisional assistant has unknown statusline usage", () => {
  const { context } = loadCommittedFixture();
  const provisional = context.query(usage(0, 0), null);

  assert.equal(provisional[0].__calicoUsageState.committed, false);
  assert.equal(readStatuslineUsage(context, provisional), null);
});

test("previous completed usage survives provisional thinking and responding wrappers", () => {
  const { context } = loadCommittedFixture();
  const completed = context.query(usage(120, 40), "end_turn");
  const thinking = context.query(usage(0, 0), null);
  const responding = context.query(usage(0, 0), null);
  const expected = usage(120, 40);

  assert.equal(completed[0].__calicoUsageState.committed, true);
  assert.deepEqual(
    readStatuslineUsage(context, [
      ...completed,
      { type: "system", subtype: "progress" },
      ...thinking,
      ...responding,
    ]),
    expected
  );
});

test("normal terminal message_delta commits assistant usage", () => {
  const { context } = loadCommittedFixture();
  const completed = context.query(usage(333, 44), "end_turn");

  assert.equal(completed[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, completed), usage(333, 44));
});

test("shallow app-state copy observes the shared terminal commit cell", () => {
  const { context } = loadCommittedFixture();
  const stateCopy = context.query(usage(0, 0), "end_turn", true, usage(333, 44), false, true);

  assert.equal(stateCopy[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, stateCopy), usage(333, 44));
});

test("later exact-zero delta cannot erase the committed snapshot", () => {
  const { context } = loadCommittedFixture();
  const stateCopy = context.query(usage(0, 0), null, true, null, false, true, [
    { usage: usage(333, 44), stopReason: "end_turn" },
    { usage: usage(0, 0), stopReason: "end_turn" },
  ]);

  assert.equal(stateCopy[0].__calicoUsageState.committed, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(stateCopy[0].__calicoUsageState.usage)),
    usage(333, 44)
  );
  assert.deepEqual(readStatuslineUsage(context, stateCopy), usage(333, 44));
});

test("downstream tool-input wrapper clones receive the terminal committed marker", () => {
  const { context } = loadCommittedFixture();
  const clones = context.query(usage(333, 44), "tool_use", true, usage(333, 44), true);

  assert.equal(clones.length, 2);
  for (const clone of clones) {
    assert.equal(clone.__calicoUsageState.committed, true);
    assert.equal(clone.message.stop_reason, "tool_use");
  }
  assert.equal(clones[0].__calicoUsageState, clones[1].__calicoUsageState);
  assert.deepEqual(readStatuslineUsage(context, clones), usage(333, 44));
});

test("DONE exact all-zero terminal sentinel does not replace the previous snapshot", () => {
  const { context } = loadCommittedFixture();
  const completed = context.query(usage(333, 44), "end_turn");
  const doneSentinel = context.query(
    usage(777, 0, 12, 0),
    "end_turn",
    true,
    { input_tokens: 0, output_tokens: 0 }
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(doneSentinel[0].message.usage)),
    usage(777, 0, 12, 0)
  );
  assert.equal(doneSentinel[0].__calicoUsageState.committed, false);
  assert.deepEqual(readStatuslineUsage(context, [...completed, ...doneSentinel]), usage(333, 44));
});

test("nested cache-only terminal usage is not an all-zero sentinel", () => {
  const { context } = loadCommittedFixture();
  const previous = context.query(usage(333, 44), "end_turn");
  const nestedCache = context.query(
    usage(0, 0),
    "end_turn",
    true,
    {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 10,
        ephemeral_5m_input_tokens: 20,
      },
    }
  );

  assert.equal(nestedCache[0].__calicoUsageState.committed, true);
  assert.deepEqual(
    readStatuslineUsage(context, [...previous, ...nestedCache]),
    usage(0, 0, 30, 0)
  );
});

test("terminal output-only zero with missing raw input is not a two-field sentinel", () => {
  const { context } = loadCommittedFixture();
  const previous = context.query(usage(333, 44), "end_turn");
  const nativeLike = context.query(
    usage(888, 55, 10, 0),
    "end_turn",
    true,
    { output_tokens: 0 }
  );

  assert.equal(nativeLike[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, [...previous, ...nativeLike]), usage(888, 0, 10, 0));
});

test("message_stop-style cleanup without terminal message_delta does not commit", () => {
  const { context } = loadCommittedFixture();
  const completed = context.query(usage(333, 44), "end_turn");
  const messageStop = context.query(usage(999, 0), null, false);

  assert.equal(messageStop[0].__calicoUsageState.committed, false);
  assert.deepEqual(readStatuslineUsage(context, [...completed, ...messageStop]), usage(333, 44));
});

test("individual zero fields remain valid when another accounting field is nonzero", () => {
  const { context } = loadCommittedFixture();
  const partialZero = context.query(
    usage(444, 55),
    "end_turn",
    true,
    usage(444, 0)
  );

  assert.equal(partialZero[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, partialZero), usage(444, 0));
});

test("direct stream-error synthesized stop_reason stays uncommitted", () => {
  const { context } = loadCommittedFixture();
  const completed = context.query(usage(333, 44), "end_turn");
  const streamError = context.query(usage(0, 0), null, false);
  streamError[0].message.stop_reason = "end_turn";

  assert.equal(streamError[0].__calicoUsageState.committed, false);
  assert.deepEqual(readStatuslineUsage(context, [...completed, ...streamError]), usage(333, 44));
});

test("legacy completed assistant without marker is accepted only with terminal signal", () => {
  const { context } = loadCommittedFixture();
  const legacyCompleted = {
    type: "assistant",
    message: {
      id: "legacy",
      model: "legacy-model",
      content: [],
      stop_reason: "end_turn",
      usage: usage(555, 0, 12, 13),
    },
  };
  const legacyZero = {
    type: "assistant",
    message: {
      id: "legacy-zero",
      model: "legacy-model",
      content: [],
      stop_reason: "end_turn",
      usage: usage(0, 0, 0, 0),
    },
  };

  assert.deepEqual(readStatuslineUsage(context, [legacyCompleted]), usage(555, 0, 12, 13));
  assert.equal(readStatuslineUsage(context, [legacyZero]), null);
});

test("statusline selection does not search across a compact boundary", () => {
  const { context } = loadCommittedFixture();
  const beforeCompact = context.query(usage(777, 22), "end_turn");
  const boundary = { type: "system", subtype: "compact_boundary" };
  const afterCompact = context.query(usage(0, 0), null, false);

  assert.deepEqual(readStatuslineUsage(context, beforeCompact), usage(777, 22));
  assert.equal(readStatuslineUsage(context, [boundary, ...afterCompact]), null);
});

test("custom context window display percentage composes with statusline payload", () => {
  const result = patchCustomContextWindows(customContextFixture);
  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);

  const context = {
    process: {
      env: {
        CALICO_MODEL_CONTEXT_WINDOWS: JSON.stringify({ "gpt-5.6-sol": 372000 }),
        CALICO_CONTEXT_DISPLAY_PERCENT: "95",
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  assert.equal(context.resolve("gpt-5.6-sol", []), 372000);
  assert.equal(
    context.status((_usage, windowValue) => windowValue, {}, 372000).context_window,
    353400
  );
});

// arm64 builds of the same version swap the effective-window body locals:
// `let n=Math.min(...),r=...;return o-n` instead of `let r=...,n=...;return o-r`.
// The matcher must capture the window/reserve locals, and the verifier marker
// must not pin `?o:o-r`. Renamed the window local to `w` too, so nothing can
// re-pin `o` in either the patcher or the verifier.
const customContextFixtureArm = customContextFixture.replace(
  "function effective(e,t){let r=Math.min(resolve(e),t),n=precomputeGate()?t:void 0,{window:o}=derive(e,n);return o-r}",
  "function effective(e,t){let n=Math.min(resolve(e),t),r=precomputeGate()?t:void 0,{window:w}=derive(e,r);return w-n}"
);

test("custom context window matches swapped arm64 effective-window locals", () => {
  const result = patchCustomContextWindows(customContextFixtureArm);
  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  assert.match(result.content, /CALICO_MODEL_CONTEXT_WINDOWS\?w:w-n/);

  assert.equal(evaluatePatchModule("custom-context-window", result.content), null);

  const context = {
    process: {
      env: {
        CALICO_MODEL_CONTEXT_WINDOWS: JSON.stringify({ "gpt-5.6-sol": 372000 }),
        CALICO_CONTEXT_DISPLAY_PERCENT: "95",
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  assert.equal(context.resolve("gpt-5.6-sol", []), 372000);
  assert.equal(
    context.status((_usage, windowValue) => windowValue, {}, 372000).context_window,
    353400
  );
});

test("matches renamed wrapper, terminal, selector, and clone locals", () => {
  const renamed = renamedCommittedUsageFixture();
  const { context, result } = loadCommittedFixture(renamed);
  const completed = context.query(usage(333, 44), "end_turn");

  assert.match(result.content, /let assistantWrapper=\{message:\{\.\.\.baseMessage/);
  assert.match(result.content, /case"message_delta":\{aggregatedUsage=aggregateUsage\(aggregatedUsage,terminalEvent\.usage\);/);
  assert.match(result.content, /for\(let assistantEntry of assistantEntries\)assistantEntry\.message\.usage=aggregatedUsage/);
  assert.match(result.content, /selectedUsage=usageReducer\(__calicoStatuslineMessages\(messageEntries\)\),windowSize=contextWindow\(modelContext,windowOptions\(\)\)/);
  assert.equal(completed[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, completed), usage(333, 44));
});

test("preserves the 2.1.212 effort metadata wrapper", () => {
  const source = effortCommittedUsageFixture();
  const { context, result } = loadCommittedFixture(source);
  const completed = context.query(usage(210, 31), "end_turn");

  assert.match(
    result.content,
    /__calicoUsageState:\{committed:!1,usage:null\},\.\.\._&&\{advisorModel:_\},\.\.\.Ie!==void 0&&\{effort:Ie\}/
  );
  assert.equal(completed[0].effort, "high");
  assert.deepEqual(readStatuslineUsage(context, completed), usage(210, 31));
  assert.equal(
    evaluatePatchModule(
      "statusline-committed-usage",
      result.content + modelsUsedCompletionSignal
    ),
    null
  );
});

test("matches the 2.1.236 batch tool-use destructured wrapper", () => {
  const source = batchCommittedUsageFixture();
  const { context, result } = loadCommittedFixture(source);
  const completed = context.query(usage(210, 31), "end_turn");

  assert.match(
    result.content,
    /__calicoUsageState:\{committed:!1,usage:null\},\.\.\._&&\{advisorModel:_\},\.\.\.Ie!==void 0&&\{effort:Ie\}/
  );
  assert.equal(completed[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, completed), usage(210, 31));
  assert.equal(
    evaluatePatchModule(
      "statusline-committed-usage",
      result.content + modelsUsedCompletionSignal
    ),
    null
  );
});

test("matches the 2.1.238 batch wrapper with the appended storageV5 argument", () => {
  const source = storageV5BatchFixture();
  const { context, result } = loadCommittedFixture(source);
  const completed = context.query(usage(210, 31), "end_turn");

  assert.match(result.content, /messageId:wo\.id\},i\.storageV5\)/);
  assert.match(
    result.content,
    /__calicoUsageState:\{committed:!1,usage:null\},\.\.\._&&\{advisorModel:_\},\.\.\.Ie!==void 0&&\{effort:Ie\}/
  );
  assert.equal(completed[0].__calicoUsageState.committed, true);
  assert.deepEqual(readStatuslineUsage(context, completed), usage(210, 31));
  assert.equal(
    evaluatePatchModule(
      "statusline-committed-usage",
      result.content + modelsUsedCompletionSignal
    ),
    null
  );
});

test("2.1.236 non-streaming fallback wrappers with inline usage are not canonical", () => {
  const source = batchCommittedUsageFixture();
  const fallback =
    'let{content:fi,batchToolUses:Gs}=K4i(ZJr(Mo.content,n,i.agentId,{requestId:ge??void 0,messageId:Lt.id}),n),sa={message:{...Lt,content:fi,usage:B5e(Wx,Lt.usage)},...Gs.length>0&&{batchToolUses:Gs},requestId:ge??void 0,...OG(i.querySource,i.spawnedBySkill,i.activeSkill,i.activeMcpServer,i.activeMcpTool),type:"assistant",uuid:sar.randomUUID(),timestamp:new Date().toISOString(),...!1,..._&&{advisorModel:_},...Ie!==void 0&&{effort:Ie}};';
  const result = patchStatuslineCommittedUsage(source + fallback);

  assert.equal(result.candidates, 6);
  assert.equal(result.patched, 6);

  const duplicateCanonical = source.replace(
    "let{content:Ct,batchToolUses:Bt}=K4i(",
    'if(0){let{content:Xt,batchToolUses:Yt}=K4i(ZJr([Zr],n,i.agentId,{requestId:ge??void 0,messageId:wo.id}),n),Zn={message:{...wo,content:Xt},...Yt.length>0&&{batchToolUses:Yt},requestId:ge??void 0,...OG(i.querySource,i.spawnedBySkill,i.activeSkill,i.activeMcpServer,i.activeMcpTool),type:"assistant",uuid:sar.randomUUID(),timestamp:new Date().toISOString(),...!1,..._&&{advisorModel:_},...Ie!==void 0&&{effort:Ie}};}let{content:Ct,batchToolUses:Bt}=K4i('
  );
  const duplicated = patchStatuslineCommittedUsage(duplicateCanonical);
  assert.equal(duplicated.patched, 0);
  assert.equal(duplicated.content, duplicateCanonical);
});

test("2.1.212 wrapper ownership rejects lost, mismatched, and duplicate effort variants", () => {
  const source = effortCommittedUsageFixture();
  const mismatchedEffort = source.replace("{effort:Ie}", "{effort:otherEffort}");
  const duplicateLegacy =
    source +
    'let Other={message:{...wo,content:ZJr([Zr],n,i.agentId,{requestId:ge??void 0,messageId:wo.id})},requestId:ge??void 0,...OG(i.querySource,i.spawnedBySkill,i.activeSkill,i.activeMcpServer,i.activeMcpTool),type:"assistant",uuid:sar.randomUUID(),timestamp:new Date().toISOString(),...!1,..._&&{advisorModel:_}};';

  for (const broken of [mismatchedEffort, duplicateLegacy]) {
    const result = patchStatuslineCommittedUsage(broken);
    assert.notEqual(broken, source);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
  }

  const patchedEffort = patchStatuslineCommittedUsage(source).content;
  const lostEffort = patchedEffort.replace(
    ",...Ie!==void 0&&{effort:Ie}",
    ""
  );
  assert.notEqual(lostEffort, patchedEffort);
  assert.notEqual(
    evaluatePatchModule(
      "statusline-committed-usage",
      lostEffort + modelsUsedCompletionSignal
    ),
    null
  );

  const patchedLegacy = patchStatuslineCommittedUsage(committedUsageFixture).content;
  assert.equal(evaluatePatchModule("statusline-committed-usage", patchedLegacy), null);
  assert.notEqual(
    evaluatePatchModule(
      "statusline-committed-usage",
      patchedLegacy + modelsUsedCompletionSignal
    ),
    null
  );
});

// Until 2.1.242 the selector was pinned to the usage reducer by name, so a
// selector calling anything else was rejected. Chunking removed that option:
// the payload builder imports the reducer under a per-chunk alias, and minified
// names are no longer unique across chunks (2.1.245 declares an unrelated
// `function Bne(` while the statusline chunk imports the reducer *as* `Bne`),
// so resolving the callee would need full cross-chunk alias resolution. The
// enforceable tie is now positional plus consumption: the selector sits
// immediately after the `?.outputStyle||` assignment, and its result and window
// must be exactly the two arguments the payload's `context_window:` is built
// from. These tests pin what that still rejects.
test("statusline selector must feed its result into context_window", () => {
  const variant = committedUsageFixture.replace(
    "return{context_window:pK_(S,b)}",
    "return{context_window:pK_(unrelatedUsage,b)}"
  );
  assert.notEqual(variant, committedUsageFixture);
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline selector must feed its window into context_window", () => {
  const variant = committedUsageFixture.replace(
    "return{context_window:pK_(S,b)}",
    "return{context_window:pK_(S,unrelatedWindow)}"
  );
  assert.notEqual(variant, committedUsageFixture);
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
});

test("statusline selector must directly follow the outputStyle assignment", () => {
  const variant = committedUsageFixture.replace(
    '_=n?.outputStyle||"default",S=aJt(o)',
    '_=n?.outputStyle||"default",spacer=0,S=aJt(o)'
  );
  assert.notEqual(variant, committedUsageFixture);
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
});

test("binary verifier rejects dead helpers and broken wrapper ownership", () => {
  const patched = patchStatuslineCommittedUsage(committedUsageFixture).content;
  assert.equal(evaluatePatchModule("statusline-committed-usage", patched), null);

  const statuslineHelper = patched.match(
    /function __calicoStatuslineMessages[\s\S]*?(?=function fK_\()/
  )?.[0];
  // Two copies of the predicates exist (one per consuming site); this is the
  // copy that precedes the status-line payload builder.
  const helperBlock = patched.match(
    /function __calicoUsageHasAccountingSignal(?:(?!function __calicoUsageHasAccountingSignal)[\s\S])*?(?=function fK_\()/g
  )?.at(-1);
  assert.ok(statuslineHelper);
  assert.ok(helperBlock);

  const emptyHelper = patched.replace(
    statuslineHelper,
    `__calicoStatuslineMessages=(e)=>e;/*${statuslineHelper}*/`
  );
  const destructuredHelpers = patched.replace(
    helperBlock,
    `var {__calicoUsageHasAccountingSignal,__calicoUsageIsExactAllZero,__calicoStatuslineMessages}={__calicoUsageHasAccountingSignal:()=>false,__calicoUsageIsExactAllZero:()=>false,__calicoStatuslineMessages:(e)=>e};/*${helperBlock}*/`
  );
  const commentOnlyHelpers = patched.replace(helperBlock, `/*${helperBlock}*/`);
  const wrongTerminalArray = patched.replace("_r.push(Kn)", "wrongArray.push(Kn)");
  const wrongCloneOwner = patched.replaceAll("eo.push({src:an,", "eo.push({src:wrongOwner,");

  assert.notEqual(evaluatePatchModule("statusline-committed-usage", emptyHelper), null);
  assert.notEqual(
    evaluatePatchModule("statusline-committed-usage", destructuredHelpers),
    null
  );
  assert.notEqual(
    evaluatePatchModule("statusline-committed-usage", commentOnlyHelpers),
    null
  );
  assert.notEqual(
    evaluatePatchModule("statusline-committed-usage", wrongTerminalArray),
    null
  );
  assert.notEqual(evaluatePatchModule("statusline-committed-usage", wrongCloneOwner), null);
});

test("statusline committed usage patch is atomic when a canonical variant is missing", () => {
  const variant = committedUsageFixture.replace(
    'S=aJt(o),b=sw(y,UE())',
    'S=aJt(o);b=sw(y,UE())'
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState.committed"), false);
});

test("statusline committed usage patch rejects a missing raw aggregation anchor", () => {
  const variant = committedUsageFixture.replace(
    "pn=xAe(pn,ar.usage);",
    "pn=xAe(previous,ar.usage);"
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState.committed"), false);
});

test("statusline committed usage patch rejects a fallback second aggregation", () => {
  const canonical = 'case"message_delta":{pn=xAe(pn,ar.usage);';
  const variant = committedUsageFixture.replace(
    canonical,
    `case"message_delta":{pn=wrong(previous,other.usage);${canonical}`
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects a missing clone synchronization anchor", () => {
  const variant = committedUsageFixture.replace(
    "for(let{src:_i,dst:Ii}of eo)Ii.usage=_i.usage,Ii.stop_reason=_i.stop_reason,Ii.stop_details=_i.stop_details;",
    "for(let pair of eo)pair.dst.usage=pair.src.usage;"
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState.committed"), false);
});

test("statusline committed usage patch rejects repeated canonical anchors", () => {
  const wrapperNeedle =
    'let Kn={message:{...wo,content:ZJr([Zr],n,i.agentId,{requestId:ge??void 0,messageId:wo.id})},requestId:ge??void 0,...OG(i.querySource,i.spawnedBySkill,i.activeSkill,i.activeMcpServer,i.activeMcpTool),type:"assistant",uuid:sar.randomUUID(),timestamp:new Date().toISOString(),...!1,..._&&{advisorModel:_}};';
  const duplicate = `${committedUsageFixture}${wrapperNeedle}`;
  const result = patchStatuslineCommittedUsage(duplicate);

  assert.equal(result.patched, 0);
  assert.equal(result.content, duplicate);
  assert.equal(result.content.includes("__calicoUsageState.committed"), false);
});

test("statusline committed usage patch rejects a terminal loop that does not own the wrapper array", () => {
  const variant = committedUsageFixture.replace("_r.push(Kn)", "wrong.push(Kn)");
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects clone registrations that use the terminal array", () => {
  const variant = committedUsageFixture.replace(
    "eo.push({src:an.message,dst:lo.message})",
    "_r.push({src:an.message,dst:lo.message})"
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects clone registrations with a wrong source", () => {
  const variant = committedUsageFixture.replace(
    "eo.push({src:an.message,dst:lo.message})",
    "eo.push({src:wrong.message,dst:lo.message})"
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects a clone event source that disagrees with registrations", () => {
  const variant = committedUsageFixture.replace(
    'if(an.type==="stream_event"&&an.event.type==="message_delta")',
    'if(wrong.type==="stream_event"&&wrong.event.type==="message_delta")'
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects terminal commit deferred into an arrow callback", () => {
  const terminal =
    "for(let Ou of _r)Ou.message.usage=pn,Ou.message.stop_reason=Se,Ou.message.stop_details=ar.delta.stop_details??null;";
  const variant = committedUsageFixture.replace(
    terminal,
    `queueMicrotask(()=>{${terminal}});`
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects clone sync deferred into an arrow callback", () => {
  const cloneSync =
    "for(let{src:_i,dst:Ii}of eo)Ii.usage=_i.usage,Ii.stop_reason=_i.stop_reason,Ii.stop_details=_i.stop_details;";
  const variant = committedUsageFixture.replace(
    cloneSync,
    `queueMicrotask(()=>{${cloneSync}});`
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("statusline committed usage patch rejects wrapper and terminal anchors split across functions", () => {
  const variant = committedUsageFixture.replace(
    "if(commit!==!1){for(let event of terminalEvents",
    "if(commit!==!1){function splitTerminal(){for(let event of terminalEvents"
  );
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

// 2.1.261 folded the aggregation assignment into the head of an `if`, as the
// first operand of a comma expression:
//
//   2.1.260  case"message_delta":{yc=rY(yc,cl.usage);let Sl=…
//   2.1.261  case"message_delta":{if(Ml=MY(Ml,La.usage),Rn!==void 0&&…)…
//
// The assignment is untouched; only the punctuation around it moved. Pinning
// the `{` against it and the trailing `;` cost the match, and the loss
// cascaded: terminalArray then resolved to the clone array, so two more guards
// went false and the module bailed with 6 candidates and 0 patched.
test("statusline committed usage patch accepts the aggregation inside an if head", () => {
  const variant = committedUsageFixture.replace(
    'case"message_delta":{pn=xAe(pn,ar.usage);',
    'case"message_delta":{if(pn=xAe(pn,ar.usage),guard!==void 0)note(guard);'
  );
  assert.notEqual(variant, committedUsageFixture);
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.candidates, 6);
  assert.equal(result.patched, 6);
  assert.ok(result.content.includes("__calicoUsageState"));
  assert.equal(evaluatePatchModule("statusline-committed-usage", result.content), null);
});

// Minified names are not unique across scopes. 2.1.261 reused one name for the
// terminal array and the clone array in two functions half a megabyte apart,
// and the guard read that as aliasing. The loops do not even destructure alike,
// so they cannot be one array at runtime; what makes them distinct is the
// declaring function, not the spelling.
test("statusline committed usage patch tolerates the same array name in another function", () => {
  const variant = committedUsageFixture
    .replace(/\beo\b/g, "pnArr")
    .replace(/\b_r\b/g, "pnArr");
  assert.notEqual(variant, committedUsageFixture);
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 6);
  assert.equal(evaluatePatchModule("statusline-committed-usage", result.content), null);
});

// Distinctness must not be inferred from the enclosing use sites: two functions
// can close over one outer array, and the same name then really is the same
// binding. Only a local declaration in the clone-sync function proves a fresh
// one, by shadowing. Here the name is shared with no such declaration.
test("statusline committed usage patch rejects a closed-over aliased array", () => {
  const variant = committedUsageFixture
    .replace(/\beo\b/g, "shared")
    .replace(/\b_r\b/g, "shared")
    .replace("let shared=", "shared=");
  assert.notEqual(variant, committedUsageFixture);
  assert.ok(!/(?:let|const|var) shared=/.test(variant));
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
});

// The two punctuation forms are paired, not a cross-product. A comma without
// the `if` is a shape the verifier's prefix check rejects, so the patcher must
// reject it too rather than emit a bundle its own verifier fails.
test("statusline committed usage patch rejects a comma terminator without the if head", () => {
  const variant = committedUsageFixture.replace(
    'case"message_delta":{pn=xAe(pn,ar.usage);',
    'case"message_delta":{pn=xAe(pn,ar.usage),next();'
  );
  assert.notEqual(variant, committedUsageFixture);
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
});
