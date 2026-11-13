// tools/local-verify/screen-lines.js replays a raw pty log onto a screen so a
// check can match one whole line. Claude Code redraws by diff: the second
// frame here rewrites only the cells that changed, so "general-purpose" is
// never contiguous in the stream, yet the screen line must read whole.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("screen-lines: a row redrawn by diff reads as one whole line", () => {
  const raw = [
    "\x1b[?25l\x1b[H\r\x1b[2B  \x1b[38;2;1;2;3m◯ ge-eral-purp-se  Calico row probe\x1b[77G0s\x1b[?25h",
    // Next frame: fix two cells and the elapsed time only.
    "\x1b[?25l\x1b[H\r\x1b[2B\x1b[7Gn\x1b[17Go\x1b[77G1s\x1b[39m\x1b[?25h",
    "\x1b[?25l\x1b[H\r\x1b[1B\x1b[K\x1b]0;title\x07\x1b[?25h",
  ].join("");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "screen-lines-")), "tui.raw");
  fs.writeFileSync(file, raw);
  const lines = execFileSync(process.execPath, [path.join(__dirname, "../tools/local-verify/screen-lines.js"), file], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(lines.some((line) => /^◯ general-purpose  Calico row probe +1s$/.test(line)), JSON.stringify(lines));
  assert.ok(!lines.some((line) => line.includes("title")));
});
