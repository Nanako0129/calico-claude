#!/usr/bin/env node
// Drive one non-interactive turn against the canned mock and report whether the
// binary completed it. Needs no credentials, no network and no PTY, which is
// the point: run.sh depends on `expect` and so covers Linux and macOS only,
// leaving the two Windows assets with no behavioural check at all. Minified
// locals differ across the five platform bundles, so a bundle verified on one
// platform proves nothing about another (PATCHING_PLAYBOOK.md).
//
// It is also the sharper signal of the two. A clone loop rewritten to walk the
// terminal array fails here as a non-zero exit with "{} is not iterable" on
// stdout, where the PTY harness saw only a request count of 1 instead of 2 —
// measured on a 2.1.260 build made deliberately aliased for the comparison.
//
//   node tools/local-verify/print-turn.js <claude-binary>

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const binary = process.argv[2];
if (!binary || !fs.existsSync(binary)) {
  console.error("usage: node tools/local-verify/print-turn.js <claude-binary>");
  process.exit(2);
}

const TURN_TIMEOUT_MS = 120_000;
const EXPECTED_TEXT = "pong from the mock";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "calico-print-turn-"));
const configDir = path.join(workDir, "config");
fs.mkdirSync(configDir, { recursive: true });

const mock = spawn(process.execPath, [path.join(__dirname, "mockapi.js"), "0"], {
  stdio: ["ignore", "ignore", "pipe"],
});

let mockLog = "";
mock.stderr.on("data", (chunk) => {
  mockLog += chunk.toString();
});

const cleanup = () => {
  mock.kill();
  fs.rmSync(workDir, { recursive: true, force: true });
};

const fail = (message) => {
  console.error(`streamed turn FAILED: ${message}`);
  cleanup();
  process.exit(1);
};

// The port is only known once the mock is listening; poll its stderr rather
// than sleeping a fixed amount, which is flaky on a loaded runner.
const waitForPort = (deadline) =>
  new Promise((resolve, reject) => {
    const tick = () => {
      const match = mockLog.match(/mock listening on (\d+)/);
      if (match) return resolve(match[1]);
      if (Date.now() > deadline) return reject(new Error("mock never reported a port"));
      setTimeout(tick, 100);
    };
    tick();
  });

(async () => {
  let port;
  try {
    port = await waitForPort(Date.now() + 30_000);
  } catch (error) {
    fail(`${error.message}\n${mockLog}`);
    return;
  }

  const child = spawn(binary, ["--print", "ping"], {
    env: {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "credential-free-test-token",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: configDir,
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    fail(`the turn did not finish within ${TURN_TIMEOUT_MS / 1000}s`);
  }, TURN_TIMEOUT_MS);

  child.on("error", (error) => {
    clearTimeout(timer);
    fail(`could not run the binary: ${error.message}`);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    const requests = (mockLog.match(/REQUEST/g) ?? []).length;
    console.log(`binary        : ${binary}`);
    console.log(`request       : ${requests > 0 ? `SENT (${requests})` : "NEVER SENT"}`);
    console.log(`exit code     : ${code}`);
    console.log(`stdout        : ${JSON.stringify(stdout.trim().slice(0, 200))}`);
    if (stderr.trim() !== "") {
      console.log(`stderr        : ${JSON.stringify(stderr.trim().slice(0, 200))}`);
    }

    if (requests === 0) fail("no request reached the mock");
    // A non-zero exit is the aliased clone loop's signature. Checking the text
    // too keeps a binary that exits 0 without answering from passing.
    if (code !== 0) fail(`the binary exited ${code}`);
    if (!stdout.includes(EXPECTED_TEXT)) {
      fail(`the mock's reply never reached stdout (expected ${JSON.stringify(EXPECTED_TEXT)})`);
    }

    console.log("streamed turn : OK");
    cleanup();
    process.exit(0);
  });
})();
