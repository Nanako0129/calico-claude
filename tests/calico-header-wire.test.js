const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchCalicoHeaderWire } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The client factory reduced to what this module touches: the header object
// (with compact-request-source's spread already in it), and the client options
// object that passes it as defaultHeaders next to the fetch spread.
const fixture = `
var customHeaders={};
function xt(){return"session-a"}
async function Zie({apiKey:e,maxRetries:t,model:r,fetchOverride:n,source:o,agentContext:i}){let p={"x-app":"cli","X-Claude-Code-Session-Id":xt(),...customHeaders,...process.env.REMORA_ACTIVE==="1"&&{"x-calico-request-source":o==="compact"?"compact":null}},q={defaultHeaders:p,maxRetries:t,...n&&{fetch:n}};return q}
async function Next(){}
`;

function load(content, env = { REMORA_ACTIVE: "1" }) {
  const context = { process: { env: { ...env } }, Headers, Request };
  vm.createContext(context);
  vm.runInContext(content, context);
  return context;
}

// The headers the innermost fetch receives when the SDK hands the wrapped fetch
// `sent` (already merged with ANTHROPIC_CUSTOM_HEADERS).
async function received(content, source, sent, env) {
  const context = load(content, env);
  let seen;
  const client = await context.Zie({
    maxRetries: 0,
    fetchOverride: (_url, init) => {
      seen = init.headers;
      return "response";
    },
    source,
  });
  assert.equal(await client.fetch("http://gateway/v1/messages", { headers: new Headers(sent) }), "response");
  return Object.fromEntries(new Headers(seen).entries());
}

test("patches the client factory's fetch once and verifies", () => {
  const result = patchCalicoHeaderWire(fixture);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("calico-header-wire", result.content), null);
  assert.match(evaluatePatchModule("calico-header-wire", fixture), /expected exactly one/);
});

// The gap the object-level null leaves: another casing is a separate key in
// the SDK's merged object and wins there. On a Headers object it is the same
// name, so the wrapper's set or delete replaces it.
test("another casing of a Calico name is replaced on the request as sent", async () => {
  const { content } = patchCalicoHeaderWire(fixture);
  const forged = { "X-Calico-Request-Source": "compact", "x-keep": "1" };
  const main = await received(content, "repl_main_thread", forged);
  assert.equal(main["x-calico-request-source"], undefined);
  assert.equal(main["x-keep"], "1");
  const compact = await received(content, "compact", { "X-Calico-Request-Source": "forged" });
  assert.equal(compact["x-calico-request-source"], "compact");
});

test("a Request input keeps its own headers", async () => {
  const { content } = patchCalicoHeaderWire(fixture);
  const context = load(content);
  let seen;
  const client = await context.Zie({
    maxRetries: 0,
    fetchOverride: (_url, init) => {
      seen = Object.fromEntries(new Headers(init.headers).entries());
    },
    source: "repl_main_thread",
  });
  const request = new Request("http://gateway/v1/messages", {
    headers: { authorization: "Bearer t", "X-Calico-Request-Source": "compact" },
  });
  await client.fetch(request);
  assert.equal(seen.authorization, "Bearer t");
  assert.equal(seen["x-calico-request-source"], undefined);
});

test("a Calico name the header object does not carry is left alone", async () => {
  const { content } = patchCalicoHeaderWire(fixture);
  const headers = await received(content, "repl_main_thread", { "X-Calico-Prompt-Id": "user-set" });
  assert.equal(headers["x-calico-prompt-id"], "user-set");
});

test("without REMORA_ACTIVE the fetch is passed through unwrapped", async () => {
  const { content } = patchCalicoHeaderWire(fixture);
  const context = load(content, {});
  const fetchOverride = () => "response";
  const client = await context.Zie({ maxRetries: 0, fetchOverride, source: "compact" });
  assert.equal(client.fetch, fetchOverride);
});

test("fails closed without exactly one defaultHeaders object and fetch spread", () => {
  for (const broken of [
    fixture.replace("q={defaultHeaders:p,", "q={headers:p,"),
    fixture.replace("...n&&{fetch:n}", "...n&&{fetch:n},...n&&{fetch:n}"),
  ]) {
    assert.notEqual(broken, fixture);
    const result = patchCalicoHeaderWire(broken);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
  }
});

test("the verifier rejects a wrapper reading a different object than defaultHeaders", () => {
  const { content } = patchCalicoHeaderWire(fixture.replace("let p={", "let x={},p={"));
  assert.equal(evaluatePatchModule("calico-header-wire", content), null);
  const other = content.replace("})(n,p):n}", "})(n,x):n}");
  assert.notEqual(other, content);
  assert.match(evaluatePatchModule("calico-header-wire", other), /not on the client factory's own fetch/);
});

test("the verifier rejects a wrapper in a factory that carries no Calico key", () => {
  const { content } = patchCalicoHeaderWire(fixture);
  const spread = ',...process.env.REMORA_ACTIVE==="1"&&{"x-calico-request-source":o==="compact"?"compact":null}';
  const bare = content.replace(spread, "");
  assert.notEqual(bare, content);
  assert.match(evaluatePatchModule("calico-header-wire", bare), /not on the client factory's own fetch/);
});

test("skips a factory without the session-id anchor the header modules use", () => {
  const other = fixture.replace('"X-Claude-Code-Session-Id":xt(),', "");
  const result = patchCalicoHeaderWire(other);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
});
