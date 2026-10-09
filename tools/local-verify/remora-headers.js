#!/usr/bin/env node
// Check the Calico-owned x-calico-* headers on the wire, under REMORA_ACTIVE=1
// with forged values in ANTHROPIC_CUSTOM_HEADERS. Runs a main turn and then
// /compact on the same session against the canned mock, and a plain main turn
// without REMORA_ACTIVE.
//
// The unit tests check the header object the client factory returns. That
// object becomes the SDK client's defaultHeaders, and the bundled SDK merges
// ANTHROPIC_CUSTOM_HEADERS back in underneath it, so a forged value the object
// no longer carried still reached the request (measured on released 2.1.283
// and 2.1.295, issue #78). Only the request the binary actually sends shows
// that.
//
//   node tools/local-verify/remora-headers.js <claude-binary> [--disable <ids>]
//
// --disable takes the patch-native disable list. The check needs all three
// modules below, so it reports itself skipped when any of them is disabled.

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) {
  console.error("usage: node tools/local-verify/remora-headers.js <claude-binary> [--disable <ids>]");
  process.exit(2);
}
const disableAt = process.argv.indexOf("--disable");
const disabled = disableAt === -1 ? [] : String(process.argv[disableAt + 1] ?? "").split(/[,\s]+/);
const needed = ["active-turn-prompt-id", "compact-request-source", "calico-header-wire"];
const off = needed.filter((id) => disabled.includes(id));
if (off.length > 0) {
  console.log(`remora headers: skipped (${off.join(", ")} disabled)`);
  process.exit(0);
}

const TURN_TIMEOUT_MS = 120_000;
const NAMES = ["x-calico-request-source", "x-calico-prompt-id", "x-calico-active-turn-version"];
// Each name all-lowercase and then Title-Case. The lowercase line lands on
// Calico's own key in the factory's header object, so it catches Calico's
// value sitting ahead of the custom headers. The Title-Case line is a separate
// key that comes after Calico's in the SDK's merged object and wins there, so
// it catches a missing calico-header-wire (measured on real 2.1.296). The
// canary is not a Calico name and must arrive, which shows the custom headers
// reached the request at all; without it, a build that stopped applying
// ANTHROPIC_CUSTOM_HEADERS would pass with nothing forged to block.
const CANARY = "x-calico-canary";
const FORGED = [
  ...NAMES.flatMap((name) => [
    `${name}: forged`,
    `${name.replace(/(^|-)([a-z])/g, (_m, dash, c) => dash + c.toUpperCase())}: forged`,
  ]),
  `${CANARY}: present`,
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

// A developer shell may select another provider, gateway or auth path through
// ANTHROPIC_* / CLAUDE_CODE_* variables, which would test a different client
// branch than CI does, so none of them are inherited.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE_CODE_)/i.test(name))
);

// The x-calico-* headers of each request the mock received during one run.
const run = (port, env, args) =>
  new Promise((resolve) => {
    const before = mockLog.length;
    const child = spawn(binary, args, {
      env: {
        ...inherited,
        ANTHROPIC_AUTH_TOKEN: "credential-free-test-token",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CONFIG_DIR: configDir,
        NO_PROXY: "127.0.0.1,localhost",
        ...env,
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
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) finish(1, `${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 200)}`);
      // The mock's stderr is read asynchronously, so its last REQUEST line can
      // arrive after the child's close. Wait until the log stops growing, for
      // at most 5 s.
      const drainUntil = Date.now() + 5_000;
      for (let seen = -1; seen !== mockLog.length; ) {
        if (Date.now() > drainUntil) finish(1, "the mock log did not settle after the run");
        seen = mockLog.length;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const requests = [...mockLog.slice(before).matchAll(/^REQUEST .* calico=(\{.*\})$/gm)].map(
        (match) => JSON.parse(match[1])
      );
      if (requests.length === 0) finish(1, `${args.join(" ")} sent no request`);
      resolve(requests);
    });
  });

(async () => {
  const port = await waitForPort();
  const remora = { ANTHROPIC_CUSTOM_HEADERS: FORGED, REMORA_ACTIVE: "1" };
  const session = crypto.randomUUID();
  const main = await run(port, remora, ["--print", "ping", "--session-id", session]);
  const compact = await run(port, remora, ["--resume", session, "--print", "/compact"]);
  const plain = await run(port, { ANTHROPIC_CUSTOM_HEADERS: "", REMORA_ACTIVE: "" }, ["--print", "ping"]);
  const show = (requests) => requests.map((h) => JSON.stringify(h)).join(" ");
  console.log(`binary        : ${binary}`);
  console.log(`main turn     : ${show(main)}`);
  console.log(`compact       : ${show(compact)}`);
  console.log(`no remora     : ${show(plain)}`);

  const forgedSent = [...main, ...compact].filter((h) =>
    Object.values(h).some((value) => value.includes("forged"))
  );
  if (forgedSent.length > 0) finish(1, "a forged ANTHROPIC_CUSTOM_HEADERS value reached the request");
  if (![...main, ...compact].every((h) => h[CANARY] === "present")) {
    finish(
      1,
      `${CANARY} missing on a request: ANTHROPIC_CUSTOM_HEADERS was not applied, or a request bypassed the model client`
    );
  }
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
  if (plain.some((h) => Object.keys(h).length > 0)) {
    finish(1, "without REMORA_ACTIVE the request carries an x-calico header");
  }
  console.log("remora headers: OK");
  finish(0);
})();
