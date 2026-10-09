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

// What the request carries, not what the factory returns. The factory's object
// becomes the SDK client's defaultHeaders; the bundled SDK merges
// ANTHROPIC_CUSTOM_HEADERS back in underneath it (`{...custom,...headers}`) and
// builds headers with the last same-name entry winning and null removing it
// (read from the 2.1.296 bundle). Checking the factory object alone is how the
// earlier delete-based sanitizer passed while real binaries leaked (issue #78).
function sent(custom, headers) {
  const out = {};
  for (const [name, value] of Object.entries({ ...custom, ...headers })) {
    if (value === null) delete out[name.toLowerCase()];
    else if (value !== undefined) out[name.toLowerCase()] = value;
  }
  return out;
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
    assert.equal(headers["x-calico-request-source"], null, source);
  }
});

test("a case-variant custom request-source does not reach a compact request", async () => {
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
  const request = sent(context.customHeaders, compactHeaders);
  assert.equal(request["x-calico-request-source"], "compact");
  assert.equal(request["x-keep"], "1");
});

test("a forged compact source does not reach non-compact remora traffic", async () => {
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
  const request = sent(context.customHeaders, mainHeaders);
  assert.equal(request["x-calico-request-source"], undefined);
  assert.equal(request["x-keep"], "1");
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
  assert.equal(compactHeaders["x-calico-prompt-id"], null);

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  assert.equal(mainHeaders["x-calico-prompt-id"], "turn-a");
  assert.equal(mainHeaders["x-calico-request-source"], null);
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
  const compactRequest = sent(context.customHeaders, compactHeaders);
  assert.equal(compactRequest["x-calico-request-source"], "compact");
  assert.equal(compactRequest["x-keep"], "1");

  const mainHeaders = await context.Zie({
    source: "repl_main_thread",
    agentContext: { agentType: "main" },
  });
  assert.equal(sent(context.customHeaders, mainHeaders)["x-calico-request-source"], undefined);
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

// 2.1.285: the session-id object is `Ob()`, spread once, then the custom
// headers in `fe`. Compact is applied after active-turn, so it has to land
// between `...fe,` and the prompt spread.
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
function Ob(r,o,t){return t}
function Ob(){return{"x-app":Tt()?"cli-bg":"cli","User-Agent":FI(),[Vpt]:z()}}
function UX(){return Ob()}
async function Zie({apiKey:e,maxRetries:n,model:r,fetchOverride:s,source:h,querySource:g=h,agentContext:b}){let B=0,Y=lf(b)?void 0:b,fe=Ylt(),Q={...Ob(),...fe,...Y?.agentId&&{"x-claude-code-agent-id":b9n(Y.agentId)}};return Q}
async function Next(){}
`;

test("hoisted custom spread stays ahead of compact and then the prompt header", async () => {
  const withActive = patchActiveTurnPromptIdentity(fixture285);
  assert.equal(withActive.patched, 2);
  const withBoth = patchCompactRequestSource(withActive.content);
  assert.equal(withBoth.candidates, 1);
  assert.equal(withBoth.patched, 1);
  const ordered =
    '...Ob(),...fe,...process.env.REMORA_ACTIVE==="1"&&{"x-calico-request-source":h==="compact"?"compact":null},...process.env.REMORA_ACTIVE==="1"&&{"x-calico-prompt-id":__calicoPromptId||null,"x-calico-active-turn-version":__calicoPromptId?"1":null},';
  assert.equal(withBoth.content.includes(ordered), true);
  assert.equal(withBoth.content.includes("...Ob(),...process.env"), false);
  assert.equal(withBoth.content.split("return Ob()").length - 1, 1);
  assert.equal(evaluatePatchModule("active-turn-prompt-id", withBoth.content), null);
  assert.equal(evaluatePatchModule("compact-request-source", withBoth.content), null);

  const context = runPatched(withBoth.content);
  // One spelling per run. All-lowercase followed by another casing wins in the
  // merged object and is replaced on the request by calico-header-wire, which
  // this object-level model does not include.
  for (const [source, prompt, version] of [
    ["x-calico-request-source", "x-calico-prompt-id", "x-calico-active-turn-version"],
    ["X-Calico-Request-Source", "X-Calico-Prompt-Id", "X-Calico-Active-Turn-Version"],
  ]) {
    context.customHeaders = { [source]: "forged", [prompt]: "forged", [version]: "forged" };
    const compactRequest = sent(
      context.customHeaders,
      await context.Zie({ source: "compact", agentContext: { agentType: "main" } })
    );
    assert.equal(compactRequest["x-calico-request-source"], "compact", source);
    assert.equal(compactRequest["x-calico-prompt-id"], undefined, prompt);
    assert.equal(compactRequest["x-calico-active-turn-version"], undefined, version);
    const mainRequest = sent(
      context.customHeaders,
      await context.Zie({
        source: "repl_main_thread",
        agentContext: { agentType: "main", agentId: "session-a" },
      })
    );
    assert.equal(mainRequest["x-calico-prompt-id"], "turn-a", prompt);
    assert.equal(mainRequest["x-calico-active-turn-version"], "1", version);
    assert.equal(mainRequest["x-calico-request-source"], undefined, source);
  }
});

test("hoisted and inline session-id anchors together patch nothing", () => {
  const bothShapes = fixture285.replace(
    "Q={...Ob(),...fe,",
    'Q={...Ob(),...fe,"X-Claude-Code-Session-Id":z(),...fe,'
  );
  const result = patchCompactRequestSource(bothShapes);
  assert.equal(result.patched, 0);
  assert.equal(result.content, bothShapes);
});

// 2.1.296 puts another binding between the custom-header declaration and the
// header object (`,Q=Qxt(),ie=await em({…}),re={...Ml(),...Q,`, read from the
// extracted 2.1.296 darwin-arm64 bundle). The local is taken from the spread
// after the helper, and the Calico headers follow that spread.
const fixture296 = fixture285
  .replace("fe=Ylt(),Q={", "fe=Ylt(),ie=await em({querySource:g}),Q={")
  .replace("async function Next(){}", "async function em(){return 1}async function Next(){}");
const COMPACT_AFTER_SPREAD =
  '...Ob(),...fe,...process.env.REMORA_ACTIVE==="1"&&{"x-calico-request-source":h==="compact"?"compact":null},';

async function headersFor(source, kind) {
  const withActive = patchActiveTurnPromptIdentity(source);
  const withBoth = patchCompactRequestSource(withActive.content);
  const context = runPatched(withBoth.content);
  context.customHeaders = { "x-calico-request-source": "forged", "x-calico-prompt-id": "forged" };
  const headers = await context.Zie({
    source: kind,
    agentContext: { agentType: "main", agentId: "session-a" },
  });
  return { withActive, withBoth, headers: sent(context.customHeaders, headers) };
}

test("2.1.296: both header modules patch with a binding between EXTRA and the header object", async () => {
  assert.notEqual(fixture296, fixture285);
  const { withActive, withBoth, headers } = await headersFor(fixture296, "repl_main_thread");
  assert.equal(withActive.patched, 2);
  assert.equal(withBoth.patched, 1);
  assert.equal(withBoth.content.includes(COMPACT_AFTER_SPREAD), true);
  assert.equal(withBoth.content.includes("fe=Ylt(),ie=await em("), true, "the declaration is left alone");
  assert.equal(evaluatePatchModule("active-turn-prompt-id", withBoth.content), null);
  assert.equal(evaluatePatchModule("compact-request-source", withBoth.content), null);
  assert.equal(headers["x-calico-prompt-id"], "turn-a");
  assert.equal(headers["x-calico-request-source"], undefined);
  const compact = await headersFor(fixture296, "compact");
  assert.equal(compact.headers["x-calico-request-source"], "compact");
});

test("2.1.296: a spread after the helper that is not a call result patches nothing", () => {
  const foreign = fixture296.replace("Q={...Ob(),...fe,", "Q={...Ob(),...B2,...fe,").replace("let B=0,", "let B=0,B2={},");
  assert.notEqual(foreign, fixture296);
  for (const apply of [patchActiveTurnPromptIdentity, patchCompactRequestSource]) {
    const result = apply(foreign);
    assert.equal(result.patched, 0);
    assert.equal(result.content, foreign);
  }
});

// Ahead of the custom spread, a forged exact-case key would overwrite the
// header inside the factory's own object.
test("2.1.296: verifier rejects the request-source header ahead of the custom spread", () => {
  const patched = patchCompactRequestSource(fixture296).content;
  assert.equal(evaluatePatchModule("compact-request-source", patched), null);
  const header = COMPACT_AFTER_SPREAD.slice("...Ob(),...fe,".length);
  const ahead = patched.replace(COMPACT_AFTER_SPREAD, `...Ob(),${header}...fe,`);
  assert.notEqual(ahead, patched);
  assert.match(evaluatePatchModule("compact-request-source", ahead), /not owned by Zie factory/);
});
