const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchCompactRequestSource,
  patchActiveTurnPromptIdentity,
} = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

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
  assert.match(result.content, /function __calicoOmitHeader/);

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

test("strips case-variant custom request-source before owning compact value", async () => {
  const result = patchCompactRequestSource(fixture);
  const context = runPatched(result.content);
  context.customHeaders = {
    "X-Calico-Request-Source": "other",
    "x-keep": "1",
  };
  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");
  assert.equal(compactHeaders["X-Calico-Request-Source"], undefined);
  assert.equal(compactHeaders["x-keep"], "1");
});

test("strips spoofed compact source on non-compact remora traffic", async () => {
  const result = patchCompactRequestSource(fixture);
  const context = runPatched(result.content);
  context.customHeaders = {
    "X-Calico-Request-Source": "compact",
    "x-keep": "1",
  };
  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main" },
  });
  assert.equal(mainHeaders["x-calico-request-source"], undefined);
  assert.equal(mainHeaders["X-Calico-Request-Source"], undefined);
  assert.equal(mainHeaders["x-keep"], "1");
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

// No shipped build has renamed the `source` local yet, but the lesson from the
// model/fetchOverride swap is that any minified local can differ per platform
// build. Rename it here so the composed header-order verifier check cannot
// silently re-pin `o`.
const fixtureRenamedSource = fixture.replace(
  "fetchOverride:n,source:o,agentContext:i",
  "fetchOverride:n,source:q,agentContext:i"
);

test("composed verifier check accepts a renamed source local", async () => {
  const withActive = patchActiveTurnPromptIdentity(fixtureRenamedSource);
  assert.equal(withActive.patched, 2);
  const withBoth = patchCompactRequestSource(withActive.content);
  assert.equal(withBoth.patched, 1);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", withBoth.content), null);
  assert.equal(evaluatePatchModule("compact-request-source", withBoth.content), null);

  const context = runPatched(withBoth.content);
  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");
});

test("owns the compact header on the 2.1.238 credentials/shifted-local shape", async () => {
  const result = patchCompactRequestSource(fixture238);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);

  const context = runPatched(result.content);
  context.customHeaders = {
    "X-Calico-Request-Source": "compact",
    "x-keep": "1",
  };
  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");
  assert.equal(compactHeaders["x-keep"], "1");

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main" },
  });
  assert.equal(mainHeaders["x-calico-request-source"], undefined);
  assert.equal(mainHeaders["X-Calico-Request-Source"], undefined);
});

// linux-arm64 and windows-arm64 builds of 2.1.238 destructure the same
// factory with the model/fetchOverride locals swapped
// (`model:n,fetchOverride:r`); locals are captured, never pinned.
const fixtureSwapped = fixture238.replace(
  "model:r,fetchOverride:n,",
  "model:n,fetchOverride:r,"
);

test("owns the compact header when model/fetchOverride locals are swapped", async () => {
  const result = patchCompactRequestSource(fixtureSwapped);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("compact-request-source", result.content), null);

  const context = runPatched(result.content);
  const compactHeaders = await context.Zie({
    source: "compact",
    agentContext: { agentType: "main" },
  });
  assert.equal(compactHeaders["x-calico-request-source"], "compact");
});

test("fails atomically when the client factory anchor is missing", () => {
  // Rename the destructured property itself; renaming only the minified
  // local must NOT break the anchor (that varies per platform build).
  const broken = fixture.replace(
    "source:o,agentContext:i",
    "src:o,agentContext:i"
  );
  const result = patchCompactRequestSource(broken);
  assert.equal(result.patched, 0);
  assert.equal(result.content, broken);
  assert.equal(result.content.includes("x-calico-request-source"), false);
});
