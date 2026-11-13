// Replay a raw TUI log (expect's log_file) onto a virtual screen and print
// every distinct screen line seen at a frame end, one per line, trimmed.
//
//   node tools/local-verify/screen-lines.js <tui.raw> [rows] [cols]
//
// Claude Code redraws by diff: it moves the cursor and writes only the cells
// that changed, so a row's text is rarely contiguous in the raw stream and a
// grep over the stripped log cannot tell which line a word landed on. This
// replays cursor moves, erases and printable text (no wrapping, no scrolling
// regions, every glyph one cell wide; enough for the 80x24 pty expect gives)
// so a check can match one whole line, e.g. the agent-panel row's glyph and
// description together.
// ponytail: a minimal VT subset; add sequences here if a screen line comes out garbled.
const fs = require("node:fs");

const [file, rowsArg, colsArg] = process.argv.slice(2);
const ROWS = Number(rowsArg) || 24;
const COLS = Number(colsArg) || 80;
const data = fs.readFileSync(file, "utf8");

const blank = () => Array(COLS).fill(" ");
let screen = Array.from({ length: ROWS }, blank);
let row = 0;
let col = 0;
const seen = new Set();
const clamp = (value, max) => Math.max(0, Math.min(max - 1, value));
const snapshot = () => {
  for (const line of screen) {
    const text = line.join("").trim();
    if (text) seen.add(text);
  }
};

for (let i = 0; i < data.length; ) {
  const char = data[i];
  if (char === "\x1b") {
    const csi = /^\x1b\[([0-9;?<>=]*)([ -\/]*)([@-~])/.exec(data.slice(i, i + 40));
    if (csi) {
      const [whole, params, , final] = csi;
      const nums = params.replace(/^[?<>=]/, "").split(";").map((n) => Number(n) || 0);
      const n = nums[0] || 1;
      if (params.startsWith("?")) {
        if (params === "?25" && final === "h") snapshot();
        if (params === "?1049" && (final === "h" || final === "l")) screen = Array.from({ length: ROWS }, blank);
      } else if (final === "A") row = clamp(row - n, ROWS);
      else if (final === "B") row = clamp(row + n, ROWS);
      else if (final === "C") col = clamp(col + n, COLS);
      else if (final === "D") col = clamp(col - n, COLS);
      else if (final === "G") col = clamp(n - 1, COLS);
      else if (final === "H" || final === "f") (row = clamp((nums[0] || 1) - 1, ROWS)), (col = clamp((nums[1] || 1) - 1, COLS));
      else if (final === "K") {
        const mode = nums[0];
        for (let c = mode === 1 ? 0 : col; c < (mode === 0 ? COLS : mode === 1 ? col + 1 : COLS); c += 1) screen[row][c] = " ";
      } else if (final === "J") {
        if (nums[0] === 2 || nums[0] === 3) screen = Array.from({ length: ROWS }, blank);
        else for (let r = row; r < ROWS; r += 1) screen[r] = r === row ? [...screen[r].slice(0, col), ...Array(COLS - col).fill(" ")] : blank();
      }
      i += whole.length;
      continue;
    }
    // OSC (title) up to BEL or ST; other two-byte escapes are skipped.
    if (data[i + 1] === "]") {
      const end = data.slice(i).search(/\x07|\x1b\\/);
      i += end === -1 ? data.length : end + (data[i + end] === "\x07" ? 1 : 2);
      continue;
    }
    i += data[i + 1] === "(" || data[i + 1] === ")" ? 3 : 2;
    continue;
  }
  if (char === "\r") col = 0;
  else if (char === "\n") row = clamp(row + 1, ROWS);
  else if (char >= " " && char !== "\x7f") {
    const glyph = String.fromCodePoint(data.codePointAt(i));
    if (col < COLS) screen[row][col] = glyph;
    col = Math.min(COLS, col + 1);
    i += glyph.length;
    continue;
  }
  i += 1;
}
snapshot();
for (const line of seen) console.log(line);
