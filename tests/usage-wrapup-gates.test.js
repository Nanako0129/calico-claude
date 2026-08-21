const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchDisableUsageWrapUpHints } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const patcherPath = path.join(__dirname, "..", "patch-claude-display.ts");

// Mirrors the 2.1.238 bundle shape: gate names assigned to minified vars, then
// read through the statsig getter `it(gate, default)` at the two injection
// sites (grace-window wrap-up and 95% near-limit checkpoint).
const fixture =
  'var GIS=3600000,VIS=300000,KIS,WHp,GHp="tengu_lantern_wick_mode",KHp,_3n="tengu_vellum_anchor",' +
  'YHp="[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work.]";' +
  'if(!Ne&&te&&cNp(Pe.depth===0)){let Wr=VHp(it(GHp,"off"));if(Wr!=="off"){inject(Wr==="next-steps"?KHp:WHp)}}' +
  "if(!Ne&&te&&Pe.depth>0&&uNp()){if(it(_3n,!1)){notice(JHp);inject(YHp)}}";

test("renames both usage wrap-up statsig gates to dead calico gates", () => {
  const result = patchDisableUsageWrapUpHints(fixture);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 2);
  assert.ok(!result.content.includes('"tengu_lantern_wick_mode"'));
  assert.ok(!result.content.includes('"tengu_vellum_anchor"'));
  assert.ok(result.content.includes('"calico_lantern_wick_off"'));
  assert.ok(result.content.includes('"calico_vellum_gone_"'));
});

test("replacement gate names preserve byte length", () => {
  const result = patchDisableUsageWrapUpHints(fixture);
  assert.equal(result.content.length, fixture.length);
});

test("is idempotent on already-patched content", () => {
  const once = patchDisableUsageWrapUpHints(fixture);
  const twice = patchDisableUsageWrapUpHints(once.content);
  assert.equal(twice.candidates, 0);
  assert.equal(twice.patched, 0);
  assert.equal(twice.content, once.content);
});

test("leaves pre-feature bundles untouched", () => {
  const oldBundle = 'var x="tengu_something_else";run(x)';
  const result = patchDisableUsageWrapUpHints(oldBundle);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
  assert.equal(result.content, oldBundle);
});

function versionedBundle(version, body) {
  return `var pkg={PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"${version}"};${body}`;
}

test("reports pre-2.1.238 bundles without gates as skipped for --assert-all", () => {
  const result = patchDisableUsageWrapUpHints(versionedBundle("2.1.237", "run()"));
  assert.equal(result.patched, 0);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /pre-2\.1\.238/);
});

test("keeps gate absence on 2.1.238+ bundles a hard failure", () => {
  const result = patchDisableUsageWrapUpHints(versionedBundle("2.1.238", "run()"));
  assert.equal(result.patched, 0);
  assert.ok(!result.skipped);
});

test("does not mark unparseable-version bundles as skipped", () => {
  const result = patchDisableUsageWrapUpHints("run()");
  assert.equal(result.patched, 0);
  assert.ok(!result.skipped);
});

test("never reports skipped when gates are present and patched", () => {
  const result = patchDisableUsageWrapUpHints(
    versionedBundle("2.1.238", fixture)
  );
  assert.equal(result.patched, 2);
  assert.ok(!result.skipped);
});

test("refuses to patch when only one gate literal survives", () => {
  // Upstream changing or removing exactly one gate must not ship a bundle
  // with the other injection path still active: nothing gets renamed and
  // patched stays 0 so --assert-all fails loudly.
  for (const survivor of ['"tengu_lantern_wick_mode"', '"tengu_vellum_anchor"']) {
    const partial = versionedBundle("2.1.238", `it(${survivor},"off")`);
    const result = patchDisableUsageWrapUpHints(partial);
    assert.ok(result.candidates > 0);
    assert.equal(result.patched, 0);
    assert.equal(result.content, partial);
    assert.ok(!result.skipped);
  }
});

test("verifier requires both renamed gates on 2.1.238+ bundles", () => {
  const both = versionedBundle(
    "2.1.238",
    'it("calico_lantern_wick_off","off");it("calico_vellum_gone_",!1)'
  );
  assert.equal(evaluatePatchModule("disable-usage-wrapup", both), null);

  const lanternOnly = versionedBundle("2.1.238", 'it("calico_lantern_wick_off","off")');
  assert.match(
    evaluatePatchModule("disable-usage-wrapup", lanternOnly),
    /expected renamed usage wrap-up gate "calico_vellum_gone_"/
  );

  const residual = versionedBundle("2.1.238", 'it("tengu_vellum_anchor",!1)');
  assert.match(
    evaluatePatchModule("disable-usage-wrapup", residual),
    /residual usage wrap-up gate/
  );

  // Pre-feature bundles carry neither name and pass with nothing to prove.
  assert.equal(
    evaluatePatchModule("disable-usage-wrapup", versionedBundle("2.1.237", "run()")),
    null
  );
});

// End-to-end --assert-all behavior through the CLI: a pre-2.1.238 bundle must
// pass as an expected skip, while a 2.1.238+ bundle missing the gates must
// still fail. All other modules are disabled via the --list-patches inventory
// so this exercises only the wrap-up module's verdict.
function runPatcherAssertAll(bundleText) {
  const listing = execFileSync(process.execPath, [patcherPath, "--list-patches"], {
    encoding: "utf8",
  });
  const otherIds = [...listing.matchAll(/^ {2}(\S+) - /gm)]
    .map((m) => m[1])
    .filter((id) => id !== "disable-usage-wrapup");
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wrapup-assertall-")),
    "content.js"
  );
  fs.writeFileSync(tmpFile, bundleText, "utf8");
  try {
    execFileSync(
      process.execPath,
      [patcherPath, "--file", tmpFile, "--disable", otherIds.join(","), "--assert-all"],
      { encoding: "utf8" }
    );
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: error.status ?? 1 };
  } finally {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }
}

test("--assert-all passes on a pre-2.1.238 bundle without gates", () => {
  assert.equal(runPatcherAssertAll(versionedBundle("2.1.237", "run()")).exitCode, 0);
});

test("--assert-all fails on a 2.1.238 bundle without gates", () => {
  assert.notEqual(runPatcherAssertAll(versionedBundle("2.1.238", "run()")).exitCode, 0);
});
