const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchActiveTurnPromptIdentity,
  patchCompactRequestSource,
  patchCompactBodyPolicy,
} = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// active-turn-prompt-id, compact-request-source and compact-body-policy all
// recognise the Anthropic client factory by the session-id entry in the header
// object it builds, and the first two inject immediately after it.
//
// 2.1.248 hoisted that header's name into a module-level constant, so the key
// went from the literal `"X-Claude-Code-Session-Id":` to a computed `[DDe]:`,
// and all three modules dropped to zero candidates at once. The constant's name
// is per-chunk minified and not unique across chunks, so the patcher matches the
// key's shape rather than the name; these fixtures pin both forms.
const literalFixture = `
var Pt={promptId:"turn-a"};
var currentContext;
var Pkr={getStore:()=>currentContext,run:(context,callback)=>{let previous=currentContext;currentContext=context;try{return callback()}finally{currentContext=previous}}};
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

// The 2.1.248 shape. `DDe` deliberately reuses a name that means something else
// elsewhere in the bundle, matching upstream, where the same minified name binds
// `4*ODe` and `$d[9]` in other chunks.
const constantFixture = literalFixture
  .replace(
    'function bhi(e){return e}',
    'function bhi(e){return e}\nvar DDe="X-Claude-Code-Session-Id";\nvar unrelated={DDe:4};'
  )
  .replace('"X-Claude-Code-Session-Id":xt(),', "[DDe]:xt(),");

function runPatched(content, env = { REMORA_ACTIVE: "1" }) {
  const context = { process: { env: { ...env } } };
  vm.createContext(context);
  vm.runInContext(content, context);
  return context;
}

for (const [shape, fixture] of [
  ["literal key", literalFixture],
  ["hoisted constant key", constantFixture],
]) {
  test(`active-turn-prompt-id patches a header object with a ${shape}`, async () => {
    const result = patchActiveTurnPromptIdentity(fixture);
    assert.equal(result.candidates, 2);
    assert.equal(result.patched, 2);
    assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

    const context = runPatched(result.content);
    const headers = await context.Zie({
      source: "repl_main_thread",
      agentContext: { agentType: "main" },
    });
    // The session id still reaches the wire under its real name, and the Calico
    // headers sit after the custom-header spread so they cannot be overridden.
    assert.equal(headers["X-Claude-Code-Session-Id"], "session-a");
    assert.equal(headers["x-calico-prompt-id"], "turn-a");
    assert.equal(headers["x-calico-active-turn-version"], "1");
  });

  test(`compact-request-source patches a header object with a ${shape}`, async () => {
    const result = patchCompactRequestSource(fixture);
    assert.equal(result.candidates, 1);
    assert.equal(result.patched, 1);
    assert.equal(evaluatePatchModule("compact-request-source", result.content), null);

    const context = runPatched(result.content);
    const compact = await context.Zie({
      source: "compact",
      agentContext: { agentType: "main" },
    });
    assert.equal(compact["X-Claude-Code-Session-Id"], "session-a");
    assert.equal(compact["x-calico-request-source"], "compact");

    const other = await context.Zie({
      source: "repl_main_thread",
      agentContext: { agentType: "main" },
    });
    assert.equal(other["x-calico-request-source"], undefined);
  });

  test(`compact-body-policy patches a client factory with a ${shape}`, () => {
    const result = patchCompactBodyPolicy(fixture);
    assert.equal(result.candidates, 1);
    assert.equal(result.patched, 1);
    assert.equal(evaluatePatchModule("compact-body-policy", result.content), null);
  });
}

test("a header object with no session-id entry is not treated as the client factory", () => {
  // Guarding on the key's shape alone would accept any computed key; the entry
  // has to keep its `<key>:<fn>(),...<custom headers>,` position in the object.
  const withoutSessionId = literalFixture.replace('"X-Claude-Code-Session-Id":xt(),', "");
  for (const patch of [
    patchActiveTurnPromptIdentity,
    patchCompactRequestSource,
    patchCompactBodyPolicy,
  ]) {
    const result = patch(withoutSessionId);
    assert.equal(result.candidates, patch === patchActiveTurnPromptIdentity ? 1 : 0);
    assert.equal(result.patched, 0);
    assert.equal(result.content, withoutSessionId);
  }
});
