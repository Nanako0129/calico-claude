// Regression tests for the class of bug where a captured minified identifier
// is interpolated into a String.replace REPLACEMENT string. `$` sequences in
// that string are special to the replace engine (`$1`-`$9` against a regex
// searchValue's capture groups, and `$$`/`$&` against both regex and string
// searchValues), and this bundle's identifier grammar
// (`[A-Za-z_$][\w$]*`) allows minifiers to hand back names containing `$`.
//
// Each fixture below binds a captured local to a name chosen to trigger one
// of those expansions, then asserts the INJECTED CODE actually reads that
// exact identifier at runtime — not merely that the patcher's own regex
// still matched.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchActiveTurnPromptIdentity,
  patchCompactRequestSource,
} = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const baseFixture = `
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

// --- Site: patchActiveTurnPromptIdentity's localsPattern replace ----------
// localsPattern is a REGEX with 5 capture groups, so both the `$1`-`$9`
// backreference rule and the `$$` collapse rule apply. sourceParam is bound
// to `$1e` (group 1 of localsPattern is contextLocal `c`) and agentContext's
// param is bound to `$$x`, exercising both rules in one fixture.
const dollarSourceFixture = baseFixture
  .replace("source:o,agentContext:i}", "source:$1e,agentContext:$$x}")
  .replace("c=$pe(i)?void 0:i,", "c=$pe($$x)?void 0:$$x,");

test("active-turn injection binds a $1e-named source and $$x-named context verbatim", async () => {
  const result = patchActiveTurnPromptIdentity(dollarSourceFixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", result.content), null);

  const context = runPatched(result.content);

  const agent = { agentType: "subagent", agentId: "agent-a" };
  context.iK(agent, () => undefined);
  assert.equal(agent.__calicoPromptId, "turn-a");

  // If `$1e` were read back as a backreference, the injected call would
  // reference `ce` (contextLocal `c` + literal `e`) instead of the real
  // `$1e` parameter, throwing a ReferenceError instead of classifying the
  // main-thread source and emitting the prompt id.
  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(mainHeaders["x-calico-active-turn-version"], "1");

  // Auxiliary sources must still be excluded — this only holds if the
  // classifier call actually reads the live `$1e` parameter value.
  const auxHeaders = await context.Zie({
    source: "quota_check",
    agentContext: { agentType: "main" },
  });
  assert.equal(auxHeaders["x-calico-prompt-id"], undefined);

  // If `$$x` had collapsed to `$x` anywhere in the injected text, `$x`
  // would be an undefined reference and this call would throw instead of
  // resolving the agent context.
  const agentHeaders = await context.Zie({
    source: "agent:custom:executor",
    agentContext: agent,
  });
  assert.equal(agentHeaders["x-calico-prompt-id"], "turn-a");
});

// --- Site: patchCompactRequestSource's header-spread replace --------------
// This site's searchValue is a regex with exactly ONE capture group, so a
// sourceParam literally named `$1` is the sharpest possible probe: if
// interpolated into a plain replacement string, `$1` expands to the entire
// captured "X-Claude-Code-Session-Id":xt(),...u, header-spread prefix
// instead of naming the source parameter.
const dollarOneSourceFixture = baseFixture.replace(
  "source:o,agentContext:i}",
  "source:$1,agentContext:i}"
);

test("compact-request-source injection binds a $1-named source verbatim", async () => {
  const result = patchCompactRequestSource(dollarOneSourceFixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("compact-request-source", result.content), null);

  const context = runPatched(result.content);

  // If `$1` had expanded to the header-spread prefix, the guard would not
  // compile to a comparison against the real parameter, and this would
  // either throw or silently fail to ever emit the compact header.
  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main" },
  });
  assert.equal(mainHeaders["x-calico-request-source"], undefined);
});

// The 2.1.250 turn-stream rewrite re-emits the whole matched selection and the
// captured hook/turn locals into its replacement. Passing that as a replacement
// STRING would collapse a `$$` inside either name to a single `$`, so the
// re-emitted expression and the injected store read would both reference a
// binding that does not exist.
const { patchThinkingStreaming } = require("../patch-claude-display.ts");

const turnStreamFixture = `
function wrapper(){let su=h$$k(t$$n?.stream,se)??li,x;if(cache[0]!==su)x=o(C,{streamingToolUses:su,isLoading:!1}),cache[0]=su,cache[1]=x;else x=cache[1];return x}
function next(){}
`;

test("turn-stream thinking injection binds $$-named hook and turn locals verbatim", () => {
  const result = patchThinkingStreaming(turnStreamFixture);
  assert.ok(result.patched > 0, "expected the turn-stream selection to patch");

  // A collapsed `$$` would leave `h$k(`/`t$n?.stream` in the output.
  assert.match(result.content, /h\$\$k\(t\$\$n\?\.stream,\(__cc_state\)=>/);
  assert.doesNotMatch(result.content, /h\$k\(/);
  assert.doesNotMatch(result.content, /t\$n\?\./);

  const thought = { messages: ["THOUGHT"] };
  const context = {
    "h$$k": undefined,
    lastProps: null,
    cache: [],
  };
  vm.createContext(context);
  vm.runInContext(
    `var h$$k=(s,f)=>s?f(s):null;` +
      `var t$$n={stream:{streamingToolUses:["tu"],streamingThinking:${JSON.stringify(thought)}}};` +
      `var se=(s)=>s.streamingToolUses,li=[],C={};` +
      `function o(c,p){lastProps=p;return{c,p}}` +
      result.content +
      `;wrapper();`,
    context
  );

  // Reaching here at all proves both names survived: a collapsed `$$` makes
  // `h$k`/`t$n` undefined and the call throws.
  assert.equal(context.lastProps.streamingThinking.messages[0], "THOUGHT");
});
