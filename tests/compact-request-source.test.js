const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchCompactRequestSource,
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

function runPatched(content, env = { REMORA_ACTIVE: "1" }) {
  const context = { process: { env: { ...env } } };
  vm.createContext(context);
  vm.runInContext(content, context);
  return context;
}

test("emits x-calico-request-source only for compact under remora", async () => {
  const result = patchCompactRequestSource(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);

  const context = runPatched(result.content);

  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");

  for (const source of ["repl_main_thread", "quota_check", "side_query", "agent:custom"]) {
    const headers = await context.Zie({
      source,
      agentContext: { agentType: "main" },
    });
    assert.equal(headers["x-calico-request-source"], undefined, source);
  }
});

test("does not emit compact header when REMORA_ACTIVE is off", async () => {
  const result = patchCompactRequestSource(fixture);
  const context = runPatched(result.content, { REMORA_ACTIVE: "0" });
  const headers = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(headers["x-calico-request-source"], undefined);
});

test("composes with active-turn without dropping either header set", async () => {
  const withActive = patchActiveTurnPromptIdentity(fixture);
  assert.equal(withActive.patched > 0, true);
  const withBoth = patchCompactRequestSource(withActive.content);
  assert.equal(withBoth.candidates, 1);
  assert.equal(withBoth.patched, 1);

  const context = runPatched(withBoth.content);

  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");
  assert.equal(compactHeaders["x-calico-prompt-id"], undefined);

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(mainHeaders["x-calico-request-source"], undefined);
});

test("fails atomically when the client factory anchor is missing", () => {
  const broken = fixture.replace(
    "source:o,agentContext:i",
    "source:querySource,agentContext:i"
  );
  const result = patchCompactRequestSource(broken);
  assert.equal(result.patched, 0);
  assert.equal(result.content, broken);
  assert.equal(result.content.includes("x-calico-request-source"), false);
});
