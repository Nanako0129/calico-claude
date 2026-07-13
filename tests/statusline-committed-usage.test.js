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

test("statusline selector is bound to the discovered usage reducer", () => {
  const variant = committedUsageFixture
    .replace("function fK_(", "function wrong(e){return null}function fK_(")
    .replace("S=aJt(o),b=sw(y,UE())", "S=wrong(o),b=sw(y,UE())");
  const result = patchStatuslineCommittedUsage(variant);

  assert.equal(result.patched, 0);
  assert.equal(result.content, variant);
  assert.equal(result.content.includes("__calicoUsageState"), false);
});

test("binary verifier rejects dead helpers and broken wrapper ownership", () => {
  const patched = patchStatuslineCommittedUsage(committedUsageFixture).content;
  assert.equal(evaluatePatchModule("statusline-committed-usage", patched), null);

  const statuslineHelper = patched.match(
    /function __calicoStatuslineMessages[\s\S]*?(?=function fK_\()/
  )?.[0];
  const helperBlock = patched.match(
    /function __calicoUsageHasAccountingSignal[\s\S]*?(?=function fK_\()/
  )?.[0];
  assert.ok(statuslineHelper);
  assert.ok(helperBlock);

  const emptyHelper = patched.replace(
    statuslineHelper,
    `var __calicoStatuslineMessages=(e)=>e;/*${statuslineHelper}*/`
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
