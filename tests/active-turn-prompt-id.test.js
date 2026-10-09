const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchActiveTurnPromptIdentity,
} = require("../patch-claude-display.ts");
const {
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const fixture = `
var Pt={promptId:"turn-a"},lastContext;
var currentContext;
var Pkr={getStore:()=>currentContext,run:(context,callback)=>{let previous=currentContext;lastContext=context;currentContext=context;try{return callback()}finally{currentContext=previous}}};
function xht(){return Pt.promptId}function $$t(e){Pt.promptId=e}
function TN(e){if(e===void 0)return;if(e.startsWith("repl_main_thread")||e==="sdk")return"main";if(e.startsWith("agent:")||e==="hook_agent")return"subagent";return"auxiliary"}
function iK(e,t){return Pkr.run(e,t)}function c_(){return{agentType:"main",agentId:xt()}}
function $pe(e){return e.agentType==="main"}
function kAi(){return customHeaders}
var customHeaders={};
function bs(){return false}
function dfe(){return"fixture"}
function xt(){return"session-a"}
function bhi(e){return e}
async function Zie({apiKey:e,maxRetries:t,model:r,fetchOverride:n,source:o,agentContext:i}){let s=process.env.CLAUDE_CODE_CONTAINER_ID,a=process.env.CLAUDE_CODE_REMOTE_SESSION_ID,l=process.env.CLAUDE_AGENT_SDK_CLIENT_APP,c=$pe(i)?void 0:i,u=kAi(),p={"x-app":bs()?"cli-bg":"cli","User-Agent":dfe(),"X-Claude-Code-Session-Id":xt(),...u,...s&&{"x-claude-remote-container-id":s},...a&&{"x-claude-remote-session-id":a},...l&&{"x-client-app":l},...c?.agentId&&{"x-claude-code-agent-id":bhi(c.agentId)},...c?.parentAgentId&&{"x-claude-code-parent-agent-id":bhi(c.parentAgentId)}};return p}
async function Next(){}
`;

// 2.1.238 appends `,credentials:s` to the Zie parameter object, which consumes
// the `s` binding and shifts the following minified locals by one letter
// (`c=…,u=…,p={` → `u=…,d=…,f={`, and the header spread `...u,` → `...d,`).
const fixture238 = fixture
  .replace("source:o,agentContext:i}", "source:o,agentContext:i,credentials:cred}")
  .replace("c=$pe(i)?void 0:i,u=kAi(),p={", "u=$pe(i)?void 0:i,d=kAi(),f={")
  .replace('"X-Claude-Code-Session-Id":xt(),...u,', '"X-Claude-Code-Session-Id":xt(),...d,')
  .replace(
    '...c?.agentId&&{"x-claude-code-agent-id":bhi(c.agentId)},...c?.parentAgentId&&{"x-claude-code-parent-agent-id":bhi(c.parentAgentId)}};return p}',
    '...u?.agentId&&{"x-claude-code-agent-id":bhi(u.agentId)},...u?.parentAgentId&&{"x-claude-code-parent-agent-id":bhi(u.parentAgentId)}};return f}'
  );

test("freezes an agent prompt id and emits it only for remora", async () => {
  const result = patchActiveTurnPromptIdentity(fixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = {
    process: { env: { REMORA_ACTIVE: "1" } },
  };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const agent = { agentType: "subagent", agentId: "agent-a" };
  context.iK(agent, () => undefined);
  assert.equal(agent.__calicoPromptId, "turn-a");

  context.Pt.promptId = "turn-b";
  const agentHeaders = await context.Zie({ source: "agent:custom:executor", agentContext: agent });
  assert.equal(agentHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(agentHeaders["x-calico-active-turn-version"], "1");

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-b");

  context.process.env.REMORA_ACTIVE = "0";
  const nativeHeaders = await context.Zie({ source: "agent:custom:executor", agentContext: agent });
  assert.equal(nativeHeaders["x-calico-prompt-id"], undefined);
  assert.equal(nativeHeaders["x-calico-active-turn-version"], undefined);
});

test("excludes auxiliary calls and protects Calico-owned headers", async () => {
  const result = patchActiveTurnPromptIdentity(fixture);
  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  // Explicit nulls, not missing keys: the SDK merges ANTHROPIC_CUSTOM_HEADERS
  // back underneath this object, and only null keeps a forged value out of
  // the request (issue #78).
  context.customHeaders = {
    "x-calico-prompt-id": "forged",
    "x-calico-active-turn-version": "999",
  };
  for (const source of ["quota_check", "count_tokens", "side_query", "compact", undefined]) {
    const headers = await context.Zie({ source, agentContext: { agentType: "main" } });
    assert.equal(headers["x-calico-prompt-id"], null, source);
    assert.equal(headers["x-calico-active-turn-version"], null, source);
  }

  const headers = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main" },
  });
  assert.equal(headers["x-calico-prompt-id"], "turn-a");
  assert.equal(headers["x-calico-active-turn-version"], "1");
});

test("nested agents inherit the frozen parent prompt", () => {
  const result = patchActiveTurnPromptIdentity(fixture);
  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const parent = { agentType: "subagent", agentId: "parent" };
  const child = { agentType: "subagent", agentId: "child" };
  context.iK(parent, () => {
    context.Pt.promptId = "turn-b";
    context.iK(child, () => undefined);
  });
  assert.equal(parent.__calicoPromptId, "turn-a");
  assert.equal(child.__calicoPromptId, "turn-a");
});

test("plain Calico launch does not mutate agent context", () => {
  const result = patchActiveTurnPromptIdentity(fixture);
  const context = { process: { env: {} } };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  const agent = { agentType: "subagent", agentId: "agent-a" };
  context.iK(agent, () => undefined);
  assert.equal(agent.__calicoPromptId, undefined);
});

test("emits the prompt id on the 2.1.238 credentials/shifted-local shape", async () => {
  const result = patchActiveTurnPromptIdentity(fixture238);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(mainHeaders["x-calico-active-turn-version"], "1");

  const auxHeaders = await context.Zie({
    source: "quota_check",
    agentContext: { agentType: "main" },
  });
  assert.equal(auxHeaders["x-calico-prompt-id"], null);
});

// 2.1.277 inserted `querySource:h=g` between `source` and `agentContext`. The
// field carries a default and its name ends in `source`, so both the
// field-order assumption and a boundary-less name lookup would misread it —
// and this factory is shared with compact-request-source and
// compact-body-policy, so all three went to zero on the same upstream edit.
const fixture277 = fixture238.replace(
  "source:o,agentContext:i",
  "source:o,querySource:qs=o,agentContext:i"
);

test("emits the prompt id through the 2.1.277 inserted querySource field", async () => {
  const result = patchActiveTurnPromptIdentity(fixture277);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(mainHeaders["x-calico-active-turn-version"], "1");

  // The sanitizer run is keyed to `agentContext`'s local, which the inserted
  // field displaced but did not replace.
  const auxHeaders = await context.Zie({
    source: "quota_check",
    agentContext: { agentType: "main" },
  });
  assert.equal(auxHeaders["x-calico-prompt-id"], null);
});

// What the `(?:^|,)` boundary in clientFactoryLocal actually guards — measured
// after Copilot pointed out on #46 that the fixture above does not: upstream's
// `querySource` is camel-cased, so a lookup for lowercase `source:` cannot bind
// it with or without a boundary. A field whose name *ends* in lowercase
// `source` is the one that collides.
const fixtureCollidingField = fixture238.replace(
  "source:o,agentContext:i",
  "xsource:zz,source:o,agentContext:i"
);

test("the field lookup ignores a field whose name ends in the one it wants", async () => {
  const result = patchActiveTurnPromptIdentity(fixtureCollidingField);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  // Keyed to the real `source`: an auxiliary call is still excluded, which a
  // gate bound to `zz` (undefined at every call) could not do.
  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  const auxHeaders = await context.Zie({
    source: "quota_check",
    agentContext: { agentType: "main" },
  });
  assert.equal(auxHeaders["x-calico-prompt-id"], null);
});

// Upstream could drop or rename `source` outright. The lookup returns null and
// the client half must apply nothing, rather than injecting a gate that reads
// an undeclared identifier — a ReferenceError inside the request path, behind
// the REMORA_ACTIVE gate where no smoke test would reach it.
const fixtureNoSource = fixture238.replace(
  "source:o,agentContext:i",
  "querySource:qs,agentContext:i"
);

test("fails closed when the factory no longer passes source", () => {
  const result = patchActiveTurnPromptIdentity(fixtureNoSource);
  assert.equal(result.patched, 0);
  assert.equal(result.content, fixtureNoSource);
  assert.equal(result.content.includes("x-calico-prompt-id"), false);
});

// linux-arm64 and windows-arm64 builds of 2.1.238 swap the minified locals
// for model/fetchOverride (`model:n,fetchOverride:r`) in the same factory;
// the signature matcher captures locals instead of pinning them.
const fixtureSwapped = fixture238.replace(
  "model:r,fetchOverride:n,",
  "model:n,fetchOverride:r,"
);

test("emits the prompt id when model/fetchOverride locals are swapped", async () => {
  const result = patchActiveTurnPromptIdentity(fixtureSwapped);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(mainHeaders["x-calico-active-turn-version"], "1");
});

test("fails atomically when either required anchor is missing", () => {
  const withoutAgentBoundary = fixture.replace(
    'function iK(e,t){return Pkr.run(e,t)}',
    'function changedAgentBoundary(e,t){return t(e)}'
  );
  const result = patchActiveTurnPromptIdentity(withoutAgentBoundary);
  assert.equal(result.patched, 0);
  assert.equal(result.content, withoutAgentBoundary);
  assert.equal(result.content.includes("x-calico-prompt-id"), false);
});

test("supports the request-journal prompt identity shape", async () => {
  const journalFixture = fixture
    .replace(
      'var Pt={promptId:"turn-a"},lastContext;',
      'var promptValue="turn-a";var pr={requestJournal:{promptId:()=>promptValue,replacePromptId:(e)=>{promptValue=e}}},lastContext;'
    )
    .replace(
      "function xht(){return Pt.promptId}function $$t(e){Pt.promptId=e}",
      "function xht(){return pr.requestJournal.promptId()}function $$t(e){pr.requestJournal.replacePromptId(e)}"
    )
    .replace(
      "function iK(e,t){return Pkr.run(e,t)}",
      'function turnKey(){return"turn-key"}function runTurn(e,t){return t()}function iK(e,t){if(!("turnAttributionKey"in e))e.turnAttributionKey=turnKey();return Pkr.run(e,()=>runTurn(e.turnAttributionKey,t))}'
    );
  const result = patchActiveTurnPromptIdentity(journalFixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const agent = { agentType: "subagent", agentId: "agent-a" };
  context.iK(agent, () => undefined);
  assert.equal(agent.__calicoPromptId, "turn-a");

  context.pr.requestJournal.replacePromptId("turn-b");
  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-b");
});

// 2.1.273 put three locals between the agent-context sanitizer assignment and
// the extra-header factory:
//
//   2.1.272  ,c=$pe(i)?void 0:i,u=kAi(),p={
//   2.1.273  ,c=$pe(i)?void 0:i,fe=Tle(),ge=fe?hNr(o,i):void 0,ve=fe?yNr(o,i):void 0,u=kAi(),p={
//
// Pinning that whole run took the client half of the module to zero and
// blocked the release. Nothing injected reads the extra-header local, so only
// the sanitizer assignment is pinned now and the header entry is found on its
// own shape.
const fixture273 = fixture.replace(
  "c=$pe(i)?void 0:i,u=kAi(),p={",
  "c=$pe(i)?void 0:i,fe=bs(),ge=fe?bhi(o):void 0,ve=fe?bhi(i):void 0,u=kAi(),p={"
);

test("tolerates locals inserted between the sanitizer and the header object", async () => {
  const result = patchActiveTurnPromptIdentity(fixture273);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const headers = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(headers["x-calico-prompt-id"], "turn-a");
  assert.equal(headers["x-calico-active-turn-version"], "1");

  // The locals upstream inserted must survive: they are re-emitted from the
  // text after the injection point, not rebuilt.
  assert.match(result.content, /ge=fe\?bhi\(o\):void 0,ve=fe\?bhi\(i\):void 0,u=kAi\(\)/);
});

// Both injections or neither. A bundle whose client factory has the sanitizer
// assignment but no session-id header entry to inject after must report zero
// rather than emit the declarations with nothing reading them.
test("fails closed when the header entry is missing", () => {
  const noHeaderEntry = fixture.replace('"X-Claude-Code-Session-Id":xt(),...u,', "...u,");
  const result = patchActiveTurnPromptIdentity(noHeaderEntry);

  assert.equal(result.patched, 0);
  assert.equal(result.content, noHeaderEntry);
  assert.equal(result.content.includes("__calicoQueryKind"), false);
});

// 2.1.285 hoists the session-id header into one zero-arg helper and spreads it
// once, after which the custom-header local is `...fe,`. `Ob(r,o,t)` and the
// bare `Ob()` call are not that helper. `Vpt` is reused as a property name;
// only the string binding identifies the key.
const fixture285 = `
var Pt={promptId:"turn-a"};
var currentContext;
var Pkr={getStore:()=>currentContext,run:(context,callback)=>{let previous=currentContext;currentContext=context;try{return callback()}finally{currentContext=previous}}};
function xht(){return Pt.promptId}function $$t(e){Pt.promptId=e}
function TN(e){if(e===void 0)return;if(e.startsWith("repl_main_thread")||e==="sdk")return"main";if(e.startsWith("agent:")||e==="hook_agent")return"subagent";return"auxiliary"}
function iK(e,t){return Pkr.run(e,t)}function c_(){return{agentType:"main",agentId:z()}}
function lf(e){return e.agentType==="main"}
function Ylt(){return customHeaders}
var customHeaders={};
function Tt(){return false}
function FI(){return"fixture"}
function z(){return"session-a"}
function b9n(e){return e}
var Vpt="X-Claude-Code-Session-Id";
var bucket={Vpt:4};
function Ob(r,o,t){return t}
function Ob(){return{"x-app":Tt()?"cli-bg":"cli","User-Agent":FI(),[Vpt]:z()}}
function UX(){return Ob()}
async function Zie({apiKey:e,maxRetries:n,model:r,fetchOverride:s,source:h,querySource:g=h,agentContext:b}){let B=0,Y=lf(b)?void 0:b,fe=Ylt(),Q={...Ob(),...fe,...Y?.agentId&&{"x-claude-code-agent-id":b9n(Y.agentId)}};return Q}
async function Next(){}
`;

test("emits the prompt header after the hoisted custom-header spread", async () => {
  const result = patchActiveTurnPromptIdentity(fixture285);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);
  const anchor = "...Ob(),...fe,";
  const at = result.content.indexOf(anchor);
  assert.notEqual(at, -1);
  assert.equal(
    result.content.startsWith(
      anchor +
        '...process.env.REMORA_ACTIVE==="1"&&{"x-calico-prompt-id":__calicoPromptId||null,"x-calico-active-turn-version":__calicoPromptId?"1":null},',
      at
    ),
    true
  );
  assert.equal(result.content.includes("...Ob(),...process.env"), false);
  assert.equal(result.content.split("return Ob()").length - 1, 1);
  assert.equal(result.content.includes("function Ob(r,o,t){return t}"), true);

  const context = { process: { env: { REMORA_ACTIVE: "1" } } };
  vm.createContext(context);
  vm.runInContext(result.content, context);
  const base = context.UX();
  assert.equal(base["X-Claude-Code-Session-Id"], "session-a");
  assert.equal(base["x-calico-prompt-id"], undefined);

  context.customHeaders = {
    "x-calico-prompt-id": "forged",
    "x-calico-active-turn-version": "999",
  };
  const headers = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(headers["X-Claude-Code-Session-Id"], "session-a");
  assert.equal(headers["x-calico-prompt-id"], "turn-a");
  assert.equal(headers["x-calico-active-turn-version"], "1");
});

test("hoisted session header fails closed without a unique helper or spread", () => {
  const missingHelper = fixture285.replace(
    'function Ob(){return{"x-app":Tt()?"cli-bg":"cli","User-Agent":FI(),[Vpt]:z()}}',
    ""
  );
  const twoSpreads = fixture285.replace(
    "async function Next(){}",
    "function decoy(){return {...Ob(),x:1}}async function Next(){}"
  );
  const bothShapes = fixture285.replace(
    "Q={...Ob(),...fe,",
    'Q={...Ob(),...fe,"X-Claude-Code-Session-Id":z(),...fe,'
  );
  for (const source of [missingHelper, twoSpreads, bothShapes]) {
    const result = patchActiveTurnPromptIdentity(source);
    assert.equal(result.patched, 0);
    assert.equal(result.content, source);
  }
});

// linux-arm64 2.1.288 spreads an unrelated, chunk-local `xw` twice in another
// Bun module. Only spreads in the helper's own module are calls to it; a second
// spread in the same module still fails closed (the test above).
test("a same-named spread in another Bun module is not the hoisted helper", async () => {
  const otherModule = fixture285.replace(
    "async function Next(){}",
    'async function Next(){}\n/*@@calico-bun-module-boundary@@*/\nvar Ob={};var s1={...Ob(),a:1},s2={...Ob(),b:2};'
  );
  const result = patchActiveTurnPromptIdentity(otherModule);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);
});
