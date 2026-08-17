const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("native patcher routes reads and writes through the fallback-aware helper", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "patch-native.ts"),
    "utf8"
  );

  assert.match(source, /await nativeContent\.readNativeContent\(outputPath\)/);
  assert.match(source, /await handle\.write\(patchedContent\)/);
  assert.doesNotMatch(source, /canNativeBunHandle\(outputPath\)/);
});
