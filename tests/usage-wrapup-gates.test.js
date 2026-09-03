const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchDisableUsageWrapUpHints } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const patcherPath = path.join(__dirname, "..", "patch-claude-display.ts");

// Mirrors the 2.1.247+ bundle shape: gate names assigned to minified vars,
// then read through the statsig getter `it(gate, default)` at the injection
// sites (grace-window wrap-up, its release note, and the 95% near-limit
// checkpoint). The text gate is read FIRST and a non-empty value stands in for
// the mode, which is why renaming the mode gate alone leaves the path live.
const fixture =
  'var GIS=3600000,VIS=300000,KIS,WHp,GHp="tengu_lantern_wick_mode",nan="tengu_lantern_wick_text",' +
  'u6o="tengu_lantern_wick_release",KHp,_3n="tengu_vellum_anchor",' +
  'YHp="[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short bullets of the most impactful remaining work.]";' +
  'if(!Ne&&te&&cNp(Pe.depth===0)){let F=ran(it(nan,"")),Wr=F!==null?"custom":VHp(it(GHp,"off"));' +
  'if(Wr!=="off"){inject(F??(Wr==="next-steps"?KHp:WHp))}}' +
  'if(Pe.depth===0&&f6o(e)){let F=d6o(it(u6o,""));if(F)inject(F)}' +
  "if(!Ne&&te&&Pe.depth>0&&uNp()){if(it(_3n,!1)){notice(JHp);inject(YHp)}}";

test("renames every usage wrap-up statsig gate to a dead calico gate", () => {
  const result = patchDisableUsageWrapUpHints(fixture);
  assert.equal(result.candidates, 4);
  assert.equal(result.patched, 4);
  for (const gate of [
    "tengu_lantern_wick_mode",
    "tengu_lantern_wick_text",
    "tengu_lantern_wick_release",
    "tengu_vellum_anchor",
  ]) {
    assert.ok(!result.content.includes(`"${gate}"`), gate);
  }
  for (const renamed of [
    "calico_lantern_wick_off",
    "calico_lantern_text_off",
    "calico_lantern_release_off",
    "calico_vellum_gone_",
  ]) {
    assert.ok(result.content.includes(`"${renamed}"`), renamed);
  }
});

// The reason the text gate has to be renamed: it is consulted before the mode
// gate and a non-empty value makes the mode irrelevant, so a bundle with only
// the mode gate renamed still injects whatever the server supplies.
test("renaming the mode gate alone leaves the text path live", () => {
  const modeOnly = fixture.replace(
    '"tengu_lantern_wick_mode"',
    '"calico_lantern_wick_off"'
  );
  assert.ok(modeOnly.includes('"tengu_lantern_wick_text"'));
  assert.match(
    evaluatePatchModule("disable-usage-wrapup", versionedBundle("2.1.259", modeOnly)),
    /residual usage wrap-up gate "tengu_lantern_wick_text"/
  );
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

// The text and release gates first appear in 2.1.247; 2.1.246 carries only the
// mode and vellum ones. Counting a missing 2.1.247 gate as a partial match on a
// 2.1.246 bundle would refuse to patch it at all, disabling nothing.
test("patches a 2.1.246 bundle that predates the text and release gates", () => {
  const bundle = versionedBundle(
    "2.1.246",
    'GHp="tengu_lantern_wick_mode",_3n="tengu_vellum_anchor";it(GHp,"off");it(_3n,!1)'
  );
  const result = patchDisableUsageWrapUpHints(bundle);
  assert.equal(result.patched, 2);
  assert.ok(!result.skipped);
  assert.ok(result.content.includes('"calico_lantern_wick_off"'));
  assert.ok(result.content.includes('"calico_vellum_gone_"'));
  assert.equal(evaluatePatchModule("disable-usage-wrapup", result.content), null);
});

test("verifier requires the text and release renames from 2.1.247", () => {
  const body =
    'GHp="calico_lantern_wick_off",_3n="calico_vellum_gone_";it(GHp,"off");it(_3n,!1)';
  // Same body, one version either side of the boundary.
  assert.equal(
    evaluatePatchModule("disable-usage-wrapup", versionedBundle("2.1.246", body)),
    null
  );
  const verdict = evaluatePatchModule(
    "disable-usage-wrapup",
    versionedBundle("2.1.247", body)
  );
  assert.match(verdict, /calico_lantern_text_off/);
  assert.match(verdict, /calico_lantern_release_off/);
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
  // 2.1.247, matching the fixture's shape: labelling a four-gate body 2.1.238
  // would ask for two gates it predates.
  const result = patchDisableUsageWrapUpHints(
    versionedBundle("2.1.247", fixture)
  );
  assert.equal(result.patched, 4);
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
