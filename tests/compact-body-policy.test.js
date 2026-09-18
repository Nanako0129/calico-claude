const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchCompactBodyPolicy,
  patchCompactRequestSource,
} = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

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

// linux-arm64 and windows-arm64 builds of 2.1.238 swap the minified locals
// for model/fetchOverride (`model:n,fetchOverride:r`). The wrap must follow
// the captured fetchOverride local; a pinned `n` would wrap the model string.
const fixtureSwapped = fixture238
  .replace("model:r,fetchOverride:n,", "model:n,fetchOverride:r,")
  .replace("return{headers:p,fetch:n}", "return{headers:p,fetch:r}");

test("wraps the swapped fetchOverride local on cross-platform builds", async () => {
  const result = patchCompactBodyPolicy(fixtureSwapped);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("compact-body-policy", result.content), null);
  assert.match(
    result.content,
    /&&o==="compact"\)\{r=__calicoCompactWrapFetch\(r\)\}/
  );

  const context = runPatched(result.content);
  const { calls } = await callWrappedFetch(context, "compact", {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
  });
  const rewritten = JSON.parse(calls[0].init.body);
  assert.equal(rewritten.output_config.effort, "medium");
  assert.equal(rewritten.model, "gpt-5.6-sol");
});

// 2.1.277 inserted `querySource:h=g` between `source` and `agentContext` — a
// field carrying a default, and one whose name ends in the very field name the
// anchor looks up. Pinning the fields in order took all three modules that
// share this factory to zero at once. The locals the wrap reads are unchanged;
// only their position in the parameter list is.
const fixture277 = fixture238.replace(
  "source:o,agentContext:i",
  "source:o,querySource:qs=o,agentContext:i"
);

test("wraps through the 2.1.277 inserted querySource field", async () => {
  const result = patchCompactBodyPolicy(fixture277);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("compact-body-policy", result.content), null);
  // The gate reads `source`, which the inserted field displaced but did not
  // replace. `querySource` is camel-cased, so a lookup for lowercase `source:`
  // cannot bind its local whether or not it has a name boundary — measured, and
  // the reason this test alone does not exercise that boundary. The two tests
  // below cover it and the fail-closed path.
  assert.match(
    result.content,
    /&&o==="compact"\)\{n=__calicoCompactWrapFetch\(n\)\}/
  );

  const context = runPatched(result.content);
  const { calls } = await callWrappedFetch(context, "compact", {
    model: "gpt-5.6-sol",
    output_config: { effort: "xhigh" },
  });
  assert.equal(JSON.parse(calls[0].init.body).output_config.effort, "medium");
});

// What the `(?:^|,)` boundary in clientFactoryLocal actually guards. Raised by
// Copilot on #46 after the fixture above was described as exercising it and
// measurably does not: a field whose name merely *ends* in lowercase `source`
// is what a boundary-less lookup binds instead.
const fixtureCollidingField = fixture238.replace(
  "source:o,agentContext:i",
  "xsource:zz,source:o,agentContext:i"
);

test("the field lookup ignores a field whose name ends in the one it wants", () => {
  const result = patchCompactBodyPolicy(fixtureCollidingField);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("compact-body-policy", result.content), null);
  // `zz` is what a lookup without the boundary returns here; the gate must
  // still be keyed to the real `source` binding.
  assert.match(
    result.content,
    /&&o==="compact"\)\{n=__calicoCompactWrapFetch\(n\)\}/
  );
  assert.equal(result.content.includes('&&zz==="compact"'), false);
});

// Upstream could drop or rename `source` outright. The lookup returns null and
// the module must then apply nothing at all, rather than injecting a gate that
// reads an undeclared identifier — which would be a ReferenceError at runtime
// inside the request path, behind the REMORA_ACTIVE gate where no smoke test
// would reach it.
const fixtureNoSource = fixture238.replace(
  "source:o,agentContext:i",
  "querySource:qs,agentContext:i"
);

test("fails closed when the factory no longer passes source", () => {
  const result = patchCompactBodyPolicy(fixtureNoSource);
  assert.equal(result.patched, 0);
  assert.equal(result.content, fixtureNoSource);
  assert.equal(result.content.includes("__calicoCompactWrapFetch"), false);

  const requestSource = patchCompactRequestSource(fixtureNoSource);
  assert.equal(requestSource.patched, 0);
  assert.equal(requestSource.content, fixtureNoSource);
  assert.equal(requestSource.content.includes("x-calico-request-source"), false);
});

test("compact-request-source also survives the inserted querySource field", () => {
  const result = patchCompactRequestSource(fixture277);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(
    evaluatePatchModule("compact-request-source", result.content),
    null
  );
  assert.match(
    result.content,
    /\.\.\.process\.env\.REMORA_ACTIVE==="1"&&o==="compact"&&\{"x-calico-request-source":"compact"\}/
  );
});

// The verifier cuts a factory's body at the next `async function `, which on a
// chunked bundle routinely runs past the end of the chunk the factory lives in.
// Both checks below would then accept injection text belonging to an entirely
// different module. Raised by Copilot on #46; these two tests are what shows
// the bounding actually rejects it, rather than the claim being taken on faith.
const BUN_MODULE_BOUNDARY = "\n/*@@calico-bun-module-boundary@@*/\n";

test("the verifier rejects a request-source inject that crosses a chunk boundary", () => {
  const patched = patchCompactRequestSource(fixture).content;
  assert.equal(evaluatePatchModule("compact-request-source", patched), null);

  // Inside the factory, after the sanitizer the adjacency check reads, and
  // before the header inject the ownership regex must still reach. Without
  // bounding, that regex's `[\s\S]*?` walks straight over the boundary and the
  // module verifies clean on a header entry from the next chunk.
  const injectIndex = patched.indexOf(
    '...process.env.REMORA_ACTIVE==="1"&&o==="compact"'
  );
  assert.notEqual(injectIndex, -1);
  const headerIndex = patched.lastIndexOf('"X-Claude-Code-Session-Id"', injectIndex);
  assert.notEqual(headerIndex, -1, "the header entry must precede the inject");
  const split =
    patched.slice(0, headerIndex) +
    BUN_MODULE_BOUNDARY +
    patched.slice(headerIndex);
  assert.equal(
    evaluatePatchModule("compact-request-source", split),
    "compact request-source sanitize/header inject is not owned by Zie factory"
  );
});

test("the verifier locates the wrapped factory by offset, not by its text", () => {
  // Two factories whose opening text is byte-identical: the wrapped one is
  // second. Resolving the opening with indexOf finds the first, so the helper
  // block sitting immediately before the wrapped factory reads as detached and
  // a correctly patched bundle is rejected.
  const patched = patchCompactBodyPolicy(fixture).content;
  assert.equal(evaluatePatchModule("compact-body-policy", patched), null);

  const opening = patched.match(/async function Zie\(\{[^{}]*\}\)\{/)[0];
  const decoy = `${opening}return{headers:{},fetch:n}}\n`;
  // Ahead of everything, so the duplicate opening is the first occurrence.
  const withDecoy = decoy + patched;
  assert.equal(
    withDecoy.indexOf(opening) < withDecoy.indexOf(decoy) + decoy.length,
    true,
    "the decoy must own the first occurrence of the opening text"
  );
  assert.equal(evaluatePatchModule("compact-body-policy", withDecoy), null);
});

test("fails atomically when Zie anchor is missing", () => {
  // Rename the destructured property itself; renaming only the minified
  // local must NOT break the anchor (that varies per platform build).
  const broken = fixture.replace(
    "source:o,agentContext:i",
    "src:o,agentContext:i"
  );
  const result = patchCompactBodyPolicy(broken);
  assert.equal(result.patched, 0);
  assert.equal(result.content, broken);
  assert.equal(result.content.includes("__calicoCompactWrapFetch"), false);
});
