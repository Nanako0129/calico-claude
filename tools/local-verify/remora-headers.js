#!/usr/bin/env node
// Check the Calico-owned x-calico-* headers on the wire, under REMORA_ACTIVE=1
// with forged values in ANTHROPIC_CUSTOM_HEADERS. Runs a main turn and then
// /compact on the same session against the canned mock.
//
// The unit tests check the header object the client factory returns. That
// object becomes the SDK client's defaultHeaders, and the bundled SDK merges
// ANTHROPIC_CUSTOM_HEADERS back in underneath it, so a forged value the object
// no longer carried still reached the request on every released build until
// issue #78. Only the request the binary actually sends shows that.
//
//   node tools/local-verify/remora-headers.js <claude-binary>

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) {
  console.error("usage: node tools/local-verify/remora-headers.js <claude-binary>");
  process.exit(2);
}

const TURN_TIMEOUT_MS = 120_000;
// One spelling per name, mixed casing: a name written twice, all-lowercase
// first, is a documented gap (patchCompactRequestSource).
const FORGED = [
  "x-calico-request-source: forged",
  "X-Calico-Prompt-Id: forged",
  "x-calico-active-turn-version: forged",
].join("\n");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "calico-remora-headers-"));
const configDir = path.join(workDir, "config");
fs.mkdirSync(configDir, { recursive: true });

const mock = spawn(process.execPath, [path.join(__dirname, "mockapi.js"), "0"], {
  stdio: ["ignore", "ignore", "pipe"],
});
let mockLog = "";
mock.stderr.on("data", (chunk) => (mockLog += chunk.toString()));

const finish = (code, message) => {
  if (message) console.error(`remora headers FAILED: ${message}`);
  mock.kill();
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(code);
};

const waitForPort = async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const match = mockLog.match(/mock listening on (\d+)/);
    if (match) return match[1];
    if (Date.now() > deadline) finish(1, `mock never reported a port\n${mockLog}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

// The x-calico-* headers of each request the mock received during one run.
const run = (port, args) =>
  new Promise((resolve) => {
    const before = mockLog.length;
    const child = spawn(binary, args, {
      env: {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: "credential-free-test-token",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_CUSTOM_HEADERS: FORGED,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CONFIG_DIR: configDir,
        NO_PROXY: "127.0.0.1,localhost",
        REMORA_ACTIVE: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1, `${args.join(" ")} did not finish within ${TURN_TIMEOUT_MS / 1000}s`);
    }, TURN_TIMEOUT_MS);
    child.on("error", (error) => finish(1, `could not run the binary: ${error.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) finish(1, `${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 200)}`);
      const requests = [...mockLog.slice(before).matchAll(/^REQUEST .* calico=(\{.*\})$/gm)].map(
        (match) => JSON.parse(match[1])
      );
      if (requests.length === 0) finish(1, `${args.join(" ")} sent no request`);
      resolve(requests);
    });
  });

(async () => {
  const port = await waitForPort();
  const session = crypto.randomUUID();
  const main = await run(port, ["--print", "ping", "--session-id", session]);
  const compact = await run(port, ["--resume", session, "--print", "/compact"]);
  console.log(`binary        : ${binary}`);
  console.log(`main turn     : ${main.map((h) => JSON.stringify(h)).join(" ")}`);
  console.log(`compact       : ${compact.map((h) => JSON.stringify(h)).join(" ")}`);

  const forged = [...main, ...compact].filter((h) =>
    Object.values(h).some((value) => value.includes("forged"))
  );
  if (forged.length > 0) finish(1, "a forged ANTHROPIC_CUSTOM_HEADERS value reached the request");
  if (main.some((h) => "x-calico-request-source" in h)) {
    finish(1, "the main turn carries x-calico-request-source");
  }
  if (!main.some((h) => h["x-calico-prompt-id"] && h["x-calico-active-turn-version"] === "1")) {
    finish(1, "the main turn carries no Calico prompt id");
  }
  if (!compact.some((h) => h["x-calico-request-source"] === "compact")) {
    finish(1, "/compact does not carry x-calico-request-source: compact");
  }
  if (compact.some((h) => "x-calico-prompt-id" in h || "x-calico-active-turn-version" in h)) {
    finish(1, "/compact carries an active-turn header");
  }
  console.log("remora headers: OK");
  finish(0);
})();
