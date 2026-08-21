const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchCompactBodyPolicy,
  patchCompactRequestSource,
} = require("../patch-claude-display.ts");

// Zie shape matches compact-request-source / active-turn anchors (Session-Id is a call).
// Returns headers plus the (possibly wrapped) fetch for body-rewrite assertions.
const fixture = `
function xt(){return"session-a"}
function kAi(){return{}}
async function Zie({apiKey:e,maxRetries:t,model:r,fetchOverride:n,source:o,agentContext:i}){let s=process.env.CLAUDE_CODE_CONTAINER_ID,a=process.env.CLAUDE_CODE_REMOTE_SESSION_ID,l=process.env.CLAUDE_AGENT_SDK_CLIENT_APP,c=i,u=kAi(),p={"x-app":"cli","User-Agent":"fixture","X-Claude-Code-Session-Id":xt(),...u,...s&&{"x-claude-remote-container-id":s},...a&&{"x-claude-remote-session-id":a},...l&&{"x-client-app":l}};return{headers:p,fetch:n}}
async function Next(){}
`;

// 2.1.238 appends `,credentials:s` to the Zie parameter object. The body-policy
// wrap is injected at the signature boundary and reads only `o`/`n`, so the
// extra destructured binding is all that must be tolerated here.
const fixture238 = fixture.replace(
  "source:o,agentContext:i}",
  "source:o,agentContext:i,credentials:cred}"
);

function runPatched(content, env = { REMORA_ACTIVE: "1" }) {
  const context = {
    process: { env: { ...env } },
    globalThis: {},
  };
  context.globalThis.fetch = async () => ({ ok: true });
  vm.createContext(context);
  vm.runInContext(content, context);
  return context;
}

async function callWrappedFetch(context, source, body, envExtra = {}) {
  Object.assign(context.process.env, envExtra);
  const calls = [];
  const upstream = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const result = await context.Zie({
    source,
    fetchOverride: upstream,
    agentContext: { agentType: "main" },
  });
  assert.equal(typeof result.fetch, "function");
  await result.fetch("https://example.test/v1/messages", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { calls, headers: result.headers };
}

test("wraps fetch and rewrites compact body effort under remora (thinking kept)", async () => {
  const result = patchCompactBodyPolicy(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.match(result.content, /function __calicoCompactWrapFetch/);

  const context = runPatched(result.content);
  const body = {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
    thinking: { type: "adaptive", display: "summarized" },
    stream: true,
  };
  const bodyStr = JSON.stringify(body);
  const calls = [];
  const upstream = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const wrapped = await context.Zie({
    source: "compact",
    fetchOverride: upstream,
    agentContext: { agentType: "main" },
  });
  await wrapped.fetch("https://example.test/v1/messages", {
    method: "POST",
    headers: [
      ["Authorization", "Bearer t"],
      ["Content-Length", String(bodyStr.length)],
      ["Content-Type", "application/json"],
    ],
    body: bodyStr,
  });
  assert.equal(calls.length, 1);
  const rewritten = JSON.parse(calls[0].init.body);
  assert.equal(rewritten.output_config.effort, "medium");
  assert.deepEqual(rewritten.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.equal(rewritten.model, "gpt-5.6-sol");
  assert.equal(rewritten.stream, true);
  // Tuple headers must keep auth/content-type while dropping Content-Length.
  const headers = calls[0].init.headers;
  assert.ok(Array.isArray(headers));
  assert.deepEqual(
    headers.filter((pair) => String(pair[0]).toLowerCase() === "content-length"),
    []
  );
  assert.equal(
    headers.find((pair) => pair[0] === "Authorization")?.[1],
    "Bearer t"
  );
});

test("optional model override, custom effort, and opt-in thinking disable", async () => {
  const result = patchCompactBodyPolicy(fixture);
  const context = runPatched(result.content, {
    REMORA_ACTIVE: "1",
    CALICO_COMPACT_EFFORT: "low",
    CALICO_COMPACT_MODEL: "gpt-5.6-terra",
    CALICO_COMPACT_DISABLE_THINKING: "1",
  });
  const { calls } = await callWrappedFetch(context, "compact", {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
    effort: "xhigh",
    thinking: { type: "adaptive" },
  });
  const rewritten = JSON.parse(calls[0].init.body);
  assert.equal(rewritten.model, "gpt-5.6-terra");
  assert.equal(rewritten.output_config.effort, "low");
  assert.equal(rewritten.effort, "low");
  assert.equal(rewritten.thinking.type, "disabled");
});

test("does not rewrite non-compact sources", async () => {
  const result = patchCompactBodyPolicy(fixture);
  const context = runPatched(result.content);
  const original = {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
    thinking: { type: "adaptive" },
  };
  for (const source of ["repl_main_thread", "quota_check", "agent:custom"]) {
    const { calls } = await callWrappedFetch(context, source, original);
    assert.deepEqual(JSON.parse(calls[0].init.body), original, source);
  }
});

test("does not wrap when REMORA_ACTIVE is off", async () => {
  const result = patchCompactBodyPolicy(fixture);
  const context = runPatched(result.content, { REMORA_ACTIVE: "0" });
  const original = {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
    thinking: { type: "adaptive" },
  };
  const { calls } = await callWrappedFetch(context, "compact", original);
  assert.deepEqual(JSON.parse(calls[0].init.body), original);
});

test("composes with compact-request-source header module", async () => {
  const withHeader = patchCompactRequestSource(fixture);
  assert.equal(withHeader.patched, 1);
  const withBoth = patchCompactBodyPolicy(withHeader.content);
  assert.equal(withBoth.patched, 1);

  const context = runPatched(withBoth.content);
  const { calls, headers } = await callWrappedFetch(context, "compact", {
    model: "m",
    output_config: { effort: "xhigh" },
    thinking: { type: "adaptive" },
  });
  assert.equal(headers["x-calico-request-source"], "compact");
  const rewritten = JSON.parse(calls[0].init.body);
  assert.equal(rewritten.output_config.effort, "medium");
  assert.deepEqual(rewritten.thinking, { type: "adaptive" });
});

test("wraps and rewrites on the 2.1.238 credentials signature shape", async () => {
  const result = patchCompactBodyPolicy(fixture238);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);

  const context = runPatched(result.content);
  const { calls } = await callWrappedFetch(context, "compact", {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
    thinking: { type: "adaptive" },
  });
  const rewritten = JSON.parse(calls[0].init.body);
  assert.equal(rewritten.output_config.effort, "medium");
});

test("fails atomically when Zie anchor is missing", () => {
  const broken = fixture.replace(
    "source:o,agentContext:i",
    "source:querySource,agentContext:i"
  );
  const result = patchCompactBodyPolicy(broken);
  assert.equal(result.patched, 0);
  assert.equal(result.content, broken);
  assert.equal(result.content.includes("__calicoCompactWrapFetch"), false);
});
