const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchActiveTurnPromptIdentity,
} = require("../patch-claude-display.ts");

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

test("freezes an agent prompt id and emits it only for remora", async () => {
  const result = patchActiveTurnPromptIdentity(fixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);

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

  for (const source of ["quota_check", "count_tokens", "side_query", "compact", undefined]) {
    const headers = await context.Zie({ source, agentContext: { agentType: "main" } });
    assert.equal(headers["x-calico-prompt-id"], undefined, source);
    assert.equal(headers["x-calico-active-turn-version"], undefined, source);
  }

  context.customHeaders = {
    "x-calico-prompt-id": "forged",
    "x-calico-active-turn-version": "999",
  };
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
