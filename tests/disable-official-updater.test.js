// A Calico build must never run Anthropic's embedded updater, and must keep
// plugin and marketplace auto-update working. Both hang off one predicate, P,
// which returns a reason object when updates are disabled and null otherwise:
// the three AutoUpdater components return early on `if(W())return`, before any
// update work, where
// `W(){return P()!==null}`, and the plugin gate is
// `G(){return W()&&!a.FORCE_AUTOUPDATE_PLUGINS}`.
//
// These assertions run the rewritten functions rather than grepping them.
// Placement is what matters and text checks cannot see it: a Calico reason
// returned FIRST would also swallow a user's own DISABLE_AUTOUPDATER, so plugins
// would keep updating against the user's explicit setting. The early-return
// variant below exists to prove the assertions can tell the two apart.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchDisableOfficialUpdater,
  CALICO_UPDATER_REASON_TEXT,
  CALICO_UPDATE_COMMAND_MESSAGE,
  CALICO_INSTALL_COMMAND_MESSAGE,
} = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const BOUNDARY = "\n/*@@calico-bun-module-boundary@@*/\n";

// The updater module as it ships (shape measured identical on 2.1.276, 2.1.277,
// 2.1.278 and 2.1.280), with every minified name injectable.
function updaterModule(n) {
  return (
    `function ${n.P}(){if(${n.env}.DISABLE_UPDATES)return{type:"env",envVar:"DISABLE_UPDATES"};` +
    `if(${n.parse}(process.env.DISABLE_AUTOUPDATER))return{type:"env",envVar:"DISABLE_AUTOUPDATER"};` +
    `let e=${n.extra}();if(e)return{type:"env",envVar:e};let n=${n.config}();` +
    `if(n.autoUpdates===!1&&(n.installMethod!=="native"||n.autoUpdatesProtectedForNative!==!0))` +
    `return{type:"config"};return null}` +
    `function ${n.W}(){return ${n.P}()!==null}` +
    `function ${n.G}(){return ${n.W}()&&!${n.env}.FORCE_AUTOUPDATE_PLUGINS}` +
    `function ${n.R}(e){switch(e.type){case"development":return"development build";` +
    'case"env":return`set by env: ${e.envVar}`;case"config":return"config"}}'
  );
}

const NAMES = {
  P: "Vde", W: "CJ", G: "AJ", R: "ort", env: "a", parse: "De", extra: "AVe", config: "ie",
};
const DOLLAR_NAMES = {
  P: "V$e", W: "$J", G: "A$", R: "o$t", env: "a", parse: "D$", extra: "$Ve", config: "i$",
};

// Runs a module's P/W/G/R with a given environment and returns what the three
// consumers would see. `process.env` inside the sandbox is the object passed.
function behaviour(source, n, env = {}) {
  const sandbox = {
    process: { env },
    [n.env]: env,
    [n.parse]: (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase()),
    [n.extra]: () => null,
    [n.config]: () => ({ autoUpdates: undefined, installMethod: "native" }),
    out: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\nout.reason=${n.P}();out.updaterDisabled=${n.W}();` +
      `out.pluginsDisabled=${n.G}();out.text=out.reason?${n.R}(out.reason):null;`,
    sandbox
  );
  return sandbox.out;
}

// The CLI registration of `update` (alias `upgrade`), as it ships in 2.1.276
// through 2.1.280 apart from locals and the chunk's hashed name.
function updateCommand(action = "R", arg = "j", fn = "q", chunk = "/$bunfs/root/chunk-b7tb8zam.js") {
  return (
    `P.command("update").alias("upgrade").description("Check for updates and install if available")` +
    `.action(${action}(async(${arg})=>{let{update:${fn}}=await import("${chunk}");await ${fn}(${arg})}))`
  );
}

// The CLI registration of `install [target]`, as it ships in 2.1.276 through
// 2.1.280 apart from its three locals and the chunk's hashed name.
function installCommand(action = "R", a = "j", b = "q", c = "W", fn = "X", chunk = "/$bunfs/root/chunk-3z93j279.js") {
  return (
    `P.command("install [target]").description("Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)")` +
    `.option("--force","Force installation even if already installed")` +
    `.action(${action}(async(${a},${b},${c})=>{let{installHandler:${fn}}=await import("${chunk}");await ${fn}(${b},${c},${a})}))`
  );
}

function patched(n = NAMES) {
  const result = patchDisableOfficialUpdater(
    `${updateCommand()};${installCommand()}${BOUNDARY}${updaterModule(n)}${BOUNDARY}suffix()`
  );
  const module = result.content.split(BOUNDARY)[1];
  return { result, module };
}

// Runs the registered action with a stub `import` and reports whether the
// update chunk was loaded, what was written to stderr, and the exit code.
async function runRegisteredAction(registration, ...args) {
  const calls = { imported: false, stderr: "", exitCode: undefined };
  const sandbox = {
    process: {
      stderr: { write: (text, done) => { calls.stderr += text; if (done) done(); } },
      exit: (code) => { calls.exitCode = code; },
    },
    R: (fn) => fn,
    P: {
      command() { return this; }, alias() { return this; }, description() { return this; },
      option() { return this; }, action(fn) { this.fn = fn; return this; },
    },
    load: async () => { calls.imported = true; return { update: async () => {}, installHandler: async () => {} }; },
  };
  vm.createContext(sandbox);
  // Dynamic import is not available in a vm context; route it to the stub.
  const source = registration.replace(/await import\("[^"]+"\)/, "await load()");
  vm.runInContext(source, sandbox);
  await sandbox.P.fn(...(args.length ? args : [{}]));
  return calls;
}
const runUpdateCommand = (registration) => runRegisteredAction(registration);
const runInstallCommand = (registration) => runRegisteredAction(registration, undefined, {}, {});

test("control: unpatched, nothing disables the updater or plugins", () => {
  const out = behaviour(updaterModule(NAMES), NAMES);
  assert.equal(out.reason, null);
  assert.equal(out.updaterDisabled, false, "the embedded updater runs");
  assert.equal(out.pluginsDisabled, false);
});

test("patched: the embedded updater is disabled, plugin auto-update is not", () => {
  const { result, module } = patched();
  assert.equal(result.candidates, 3, "the updater module, the update command and the install command");
  assert.equal(result.patched, 3);
  const out = behaviour(module, NAMES);
  assert.equal(out.reason.type, "calico");
  assert.equal(out.updaterDisabled, true, "every AutoUpdater component returns early");
  assert.equal(out.pluginsDisabled, false, "plugins keep auto-updating");
  assert.equal(out.text, CALICO_UPDATER_REASON_TEXT, "doctor and /config show the Calico reason");
});

test("patched: a user's own DISABLE_AUTOUPDATER still wins and still disables plugins", () => {
  const { module } = patched();
  const out = behaviour(module, NAMES, { DISABLE_AUTOUPDATER: "1" });
  assert.equal(out.reason.type, "env");
  assert.equal(out.reason.envVar, "DISABLE_AUTOUPDATER");
  assert.equal(out.pluginsDisabled, true, "upstream semantics for a user-set reason");
  assert.equal(out.text, "set by env: DISABLE_AUTOUPDATER");

  const forced = behaviour(module, NAMES, { DISABLE_AUTOUPDATER: "1", FORCE_AUTOUPDATE_PLUGINS: "1" });
  assert.equal(forced.pluginsDisabled, false, "FORCE_AUTOUPDATE_PLUGINS keeps its meaning");
});

test("the assertions above can tell end placement from an early return", () => {
  // Same rewrite of G and R, but the Calico reason returned as P's first
  // statement. It must behave differently under a user-set DISABLE_AUTOUPDATER,
  // or the previous test would pass for the wrong placement too.
  const { module } = patched();
  const early = module.replace(
    `function ${NAMES.P}(){`,
    `function ${NAMES.P}(){return{type:"calico"};`
  );
  const out = behaviour(early, NAMES, { DISABLE_AUTOUPDATER: "1" });
  assert.equal(out.reason.type, "calico");
  assert.equal(out.pluginsDisabled, false, "an early return would swallow the user's setting");
});

test("names containing $ survive the rewrite", () => {
  const { result, module } = patched(DOLLAR_NAMES);
  assert.equal(result.patched, 3);
  const out = behaviour(module, DOLLAR_NAMES);
  assert.equal(out.reason.type, "calico");
  assert.equal(out.updaterDisabled, true);
  assert.equal(out.pluginsDisabled, false);
});

test("all or nothing: a module missing the plugin gate is left untouched", () => {
  const n = NAMES;
  const withoutGate = updaterModule(n).replace(
    `function ${n.G}(){return ${n.W}()&&!${n.env}.FORCE_AUTOUPDATE_PLUGINS}`,
    ""
  );
  const input = `x()${BOUNDARY}${withoutGate}`;
  const result = patchDisableOfficialUpdater(input);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 0, "rewriting P alone would silently disable plugin updates");
  assert.equal(result.content, input);
});

test("rewrites stay inside P's module even when another module reuses its names", () => {
  // Measured: 2.1.277 and 2.1.280 each have an unrelated function elsewhere in
  // the bundle with P's name. A decoy gate in a neighbouring module must not be
  // taken for this one.
  const decoy = `function ${NAMES.G}(){return ${NAMES.W}()&&!a.FORCE_AUTOUPDATE_PLUGINS}function ${NAMES.P}(){return 1}`;
  const result = patchDisableOfficialUpdater(`${decoy}${BOUNDARY}${updaterModule(NAMES)}`);
  const [decoyAfter] = result.content.split(BOUNDARY);
  assert.equal(result.patched, 1, "no update command in this input, so one candidate");
  assert.equal(decoyAfter, decoy, "the neighbouring module is byte-identical");
});

test("a predicate with a second null exit is not patched", () => {
  const n = NAMES;
  const extraExit = updaterModule(n).replace("let e=", "if(globalThis.x)return null;let e=");
  const result = patchDisableOfficialUpdater(extraExit);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 0, "that exit would still let the updater run");
});

test("verifier accepts the patched module and rejects unpatched or half-patched ones", () => {
  const check = (content) => evaluatePatchModule("disable-official-updater", content);
  const { result } = patched();
  assert.equal(check(result.content), null);

  assert.match(check(updaterModule(NAMES)), /does not end with the Calico reason/);

  const pOnly = updaterModule(NAMES).replace('return{type:"config"};return null}', 'return{type:"config"};return{type:"calico"}}');
  assert.match(check(pOnly), /residual unmodified plugin gate/);

  const secondExit = result.content.replace("let e=", "if(globalThis.x)return null;let e=");
  assert.match(check(secondExit), /null or undefined exit/);
});

test("control: unpatched, the update command loads the updater", async () => {
  const calls = await runUpdateCommand(updateCommand());
  assert.equal(calls.imported, true);
  assert.equal(calls.exitCode, undefined);
});

test("patched: the update command installs nothing, says why, and exits 1", async () => {
  const { result } = patched();
  const [registrations] = result.content.split(BOUNDARY);
  const calls = await runUpdateCommand(registrations.slice(0, registrations.indexOf(';P.command("install [target]")')));
  assert.equal(calls.imported, false, "the update chunk is never loaded");
  assert.equal(calls.stderr, CALICO_UPDATE_COMMAND_MESSAGE);
  assert.equal(calls.exitCode, 1, "exits itself, and nothing was installed, so not a success");
});

test("update command rewrite survives $ in locals and a different chunk name", async () => {
  const input = updateCommand("R$", "$j", "q$", "/$bunfs/root/chunk-00000000.js");
  const result = patchDisableOfficialUpdater(input);
  assert.equal(result.patched, 1);
  assert.equal(result.content.includes("let{update:"), false);
});

test("verifier rejects a build whose update command still imports the updater", () => {
  const check = (content) => evaluatePatchModule("disable-official-updater", content);
  const moduleOnly = patchDisableOfficialUpdater(updaterModule(NAMES)).content;
  assert.match(check(`${updateCommand()}${BOUNDARY}${moduleOnly}`), /residual update command/);
});

test("control: unpatched, the install command loads the installer", async () => {
  const calls = await runInstallCommand(installCommand());
  assert.equal(calls.imported, true);
  assert.equal(calls.exitCode, undefined);
});

test("patched: the install command installs nothing, says why, and exits 1", async () => {
  const { result } = patched();
  const [registrations] = result.content.split(BOUNDARY);
  const install = registrations.slice(registrations.indexOf('P.command("install [target]")'));
  assert.ok(install.startsWith('P.command("install [target]")'));
  const calls = await runInstallCommand(install);
  assert.equal(calls.imported, false, "the installer chunk is never loaded");
  assert.equal(calls.stderr, CALICO_INSTALL_COMMAND_MESSAGE);
  assert.equal(calls.exitCode, 1);
});

test("install command rewrite survives $ in locals and a different chunk name", () => {
  const input = installCommand("R$", "$a", "b$", "$c", "X$", "/$bunfs/root/chunk-11111111.js");
  const result = patchDisableOfficialUpdater(input);
  assert.equal(result.patched, 1);
  assert.equal(result.content.includes("{let{installHandler:"), false);
});

test("verifier rejects a build whose install command still imports the installer", () => {
  const check = (content) => evaluatePatchModule("disable-official-updater", content);
  const rest = patchDisableOfficialUpdater(`${updateCommand()}${BOUNDARY}${updaterModule(NAMES)}`).content;
  assert.match(check(`${installCommand()}${rest}`), /residual install command/);
});

// 2.1.295 gave P a parameter (the DISABLE_AUTOUPDATER flag), put a shim Q
// between it and W, and rewrote the plugin gate with a host-pin branch that
// reads P directly. Reconstructed from the 2.1.295 darwin-arm64 bundle with
// minified names kept; the pin log message is shortened and `t` is a stub.
function hostPinModule(n) {
  return (
    `function ${n.W}(){return ${n.Q}()!==null}` +
    `function ${n.G}(){if(${n.env}.FORCE_AUTOUPDATE_PLUGINS)return!1;` +
    `if(!${n.env}.CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST)return ${n.W}();` +
    `let e=import.meta.require("/$bunfs/root/chunk-wyef8a71.js");if(${n.P}(!1)!==null)return!0;` +
    `let n=e.findSkipReasonUnderHostPin(${n.config}().env);if(n!==null)t(\`off (\${n})\`);return n!==null}` +
    `function ${n.R}(e){switch(e.type){case"development":return"development build";` +
    'case"env":return`set by env: ${e.envVar}`;case"config":return"config"}}' +
    `function ${n.Q}(){return ${n.P}(${n.parse}(process.env.DISABLE_AUTOUPDATER))}` +
    `function ${n.P}(e){if(${n.env}.DISABLE_UPDATES)return{type:"env",envVar:"DISABLE_UPDATES"};` +
    `if(e)return{type:"env",envVar:"DISABLE_AUTOUPDATER"};let n=${n.extra}();if(n)return{type:"env",envVar:n};` +
    `let r=${n.config}();if(r.autoUpdates===!1&&(r.installMethod!=="native"||r.autoUpdatesProtectedForNative!==!0))` +
    `return{type:"config"};return null}`
  );
}

const HOST_NAMES = { ...NAMES, P: "rA", Q: "kRe", W: "Jde", G: "Ooe", R: "aZt" };
const HOST_DOLLAR_NAMES = { ...DOLLAR_NAMES, P: "r$A", Q: "$kRe", W: "Jd$", G: "O$e", R: "a$Zt" };

function hostBehaviour(source, n, env = {}, pinReason = null) {
  const sandbox = {
    process: { env },
    [n.env]: env,
    [n.parse]: (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase()),
    [n.extra]: () => null,
    [n.config]: () => ({ autoUpdates: undefined, installMethod: "native", env: {} }),
    __req: () => ({ findSkipReasonUnderHostPin: () => pinReason }),
    t: () => {},
    out: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source.replace("import.meta.require", "__req")}\nout.reason=${n.Q}();out.updaterDisabled=${n.W}();` +
      `out.pluginsDisabled=${n.G}();out.text=out.reason?${n.R}(out.reason):null;`,
    sandbox
  );
  return sandbox.out;
}

function hostPatched(n = HOST_NAMES) {
  const result = patchDisableOfficialUpdater(`x()${BOUNDARY}${hostPinModule(n)}${BOUNDARY}suffix()`);
  return { result, module: result.content.split(BOUNDARY)[1] };
}

test("2.1.295 control: unpatched, nothing disables the updater or plugins, pinned or not", () => {
  for (const host of [undefined, "1"]) {
    const out = hostBehaviour(hostPinModule(HOST_NAMES), HOST_NAMES, { CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: host });
    assert.equal(out.reason, null);
    assert.equal(out.updaterDisabled, false);
    assert.equal(out.pluginsDisabled, false);
  }
});

test("2.1.295 patched: updater disabled, plugin auto-update kept on both gate paths", () => {
  for (const n of [HOST_NAMES, HOST_DOLLAR_NAMES]) {
    const { result, module } = hostPatched(n);
    assert.equal(result.patched, 1);
    const free = hostBehaviour(module, n);
    assert.equal(free.reason.type, "calico");
    assert.equal(free.updaterDisabled, true, "every AutoUpdater component returns early");
    assert.equal(free.pluginsDisabled, false, "unpinned path ignores the Calico reason");
    assert.equal(free.text, CALICO_UPDATER_REASON_TEXT);

    const pinned = hostBehaviour(module, n, { CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: "1" });
    assert.equal(pinned.pluginsDisabled, false, "host-pin path ignores the Calico reason too");
    const pinSkip = hostBehaviour(module, n, { CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: "1" }, "pinned");
    assert.equal(pinSkip.pluginsDisabled, true, "the host's own pin still applies");
  }
});

test("2.1.295 patched: a user's DISABLE_UPDATES still disables plugins on both paths", () => {
  const { module } = hostPatched();
  for (const host of [undefined, "1"]) {
    const out = hostBehaviour(module, HOST_NAMES, { DISABLE_UPDATES: "1", CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: host });
    assert.equal(out.reason.envVar, "DISABLE_UPDATES");
    assert.equal(out.pluginsDisabled, true);
  }
  const user = hostBehaviour(module, HOST_NAMES, { DISABLE_AUTOUPDATER: "1" });
  assert.equal(user.pluginsDisabled, true, "unpinned: DISABLE_AUTOUPDATER keeps upstream meaning");
});

test("2.1.295 all or nothing: a gate without the direct host-pin read is left untouched", () => {
  const n = HOST_NAMES;
  const input = `x()${BOUNDARY}${hostPinModule(n).replace(`if(${n.P}(!1)!==null)return!0;`, "")}`;
  const result = patchDisableOfficialUpdater(input);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 0);
  assert.equal(result.content, input);
});

test("2.1.295 verifier accepts the patched module and rejects a half-patched gate", () => {
  const check = (content) => evaluatePatchModule("disable-official-updater", content);
  const { result } = hostPatched();
  const withCommands = patchDisableOfficialUpdater(`${updateCommand()};${installCommand()}`).content;
  assert.equal(check(`${withCommands}${result.content}`), null);

  const directLeft = result.content.replace(
    /\{let __calicoUpdaterReason=rA\(!1\);if\([^)]*\)return!0\}/,
    "if(rA(!1)!==null)return!0;"
  );
  assert.match(check(`${withCommands}${directLeft}`), /host-pin form: 1 wrapper read, 0 direct read, 1 unmodified/);
});

test("2.1.295 shim is the function the wrapper calls, not the first one returning P", () => {
  const n = HOST_NAMES;
  const decoyShim = `function zZ(){return ${n.P}(!0)}`;
  const input = `x()${BOUNDARY}${decoyShim}${hostPinModule(n)}`;
  const { content, patched } = patchDisableOfficialUpdater(input);
  assert.equal(patched, 1);
  const module = content.split(BOUNDARY)[1];
  assert.ok(module.includes(`{let __calicoUpdaterReason=${n.Q}();return `), "gate reads the real shim");
  assert.equal(hostBehaviour(module, n).pluginsDisabled, false);
});

test("2.1.295 verifier rejects a gate rewired to a function other than P's shim", () => {
  const check = (content) => evaluatePatchModule("disable-official-updater", content);
  const withCommands = patchDisableOfficialUpdater(`${updateCommand()};${installCommand()}`).content;
  const { result } = hostPatched();
  const rewired = result.content.replace(
    `{let __calicoUpdaterReason=${HOST_NAMES.Q}();`,
    `{let __calicoUpdaterReason=${HOST_NAMES.extra}();`
  );
  assert.notEqual(rewired, result.content);
  assert.match(check(`${withCommands}${rewired}`), /host-pin form: 0 wrapper read/);

  // A stray old-form gate does not stand in for an unpatched host gate.
  const strayLegacyGate =
    `function AJ(){let __calicoUpdaterReason=${HOST_NAMES.P}();` +
    `return __calicoUpdaterReason!==null&&__calicoUpdaterReason.type!=="calico"&&!a.FORCE_AUTOUPDATE_PLUGINS}`;
  const unpatchedHost = result.content.replace(
    /\{let __calicoUpdaterReason=rA\(!1\);if\([^)]*\)return!0\}/,
    "if(rA(!1)!==null)return!0;"
  );
  assert.notEqual(unpatchedHost, result.content);
  assert.match(check(`${withCommands}${strayLegacyGate}${unpatchedHost}`), /found 1 \(host-pin form: 1 wrapper read, 0 direct read, 1 unmodified\)/);
});

test("verifier rejects a legacy-form build that still has an unrewritten direct P read", () => {
  const check = (content) => evaluatePatchModule("disable-official-updater", content);
  const { result } = patched();
  assert.equal(check(result.content), null);
  assert.match(check(`${result.content};if(${NAMES.P}(!1)!==null)return!0;`), /1 unmodified/);
});
