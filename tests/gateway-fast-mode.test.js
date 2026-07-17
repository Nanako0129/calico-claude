const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { patchGatewayFastMode } = require("../patch-claude-display.ts");
const {
  evaluatePatchModule,
} = require("../scripts/verify-patched-binary.ts");

const fixture = `
var nativeAvailable=!1,nativeReason="Fast mode is not available",nativeCalls=[],pickerCalls=0,logs=[];
function sl(){return nativeAvailable}
function IDe(){return nativeReason}
async function Ujt(){}
async function jTo(e,t,r,n,o,i=!0){nativeCalls.push({enabled:e,source:n,persist:i});return e?"Native Fast mode ON":"Native Fast mode OFF"}
function M(){pickerCalls++}
var ug={jsx:(component,props)=>({component,props})},Gun=function Gun(){};
function R9(){return"claude-opus-4-8"}
function usr(){return!0}
function pn(){return nativeAvailable}
function rwd(){}
function twd(){}
async function Wj_(e,t,r){if(!sl())return e(IDe()??"Fast mode is not available"),null;await Ujt();let n=r?.trim().toLowerCase();if(n==="on"||n==="off"){let i=await jTo(n==="on",t.getAppState,t.setAppState,"shortcut",t.onQueryEvent);return e(i),null}let o=IDe();return M("tengu_fast_mode_picker_shown",{unavailable_reason:o??""}),ug.jsx(Gun,{onDone:e,unavailableReason:o})}
async function VPy(e,t){if(!sl())return{type:"text",value:IDe()??"Fast mode is not available"};await Ujt();let r=e.trim().toLowerCase(),n;if(r==="on")n=!0;else if(r==="off")n=!1;else if(r==="")n=!t.options.fastMode;else return{type:"text",value:\`Unknown argument "\${r}". Use: /fast [on|off]\`};return{type:"text",value:await jTo(n,t.getAppState,t.setAppState,"bridge",t.onQueryEvent,!t.options.isNonInteractiveSession)}}
var zPy={type:"local-jsx",name:"fast",get description(){return\`Toggle fast mode (\${R9()})\`},get isHidden(){return!sl()},argumentHint:"[on|off]",get immediate(){return usr()},requires:{ink:!0},thinClientDispatch:"control-request"};
var wSs={type:"local",name:"fast",supportsNonInteractive:!0,get description(){return\`Toggle fast mode (\${R9()})\`},argumentHint:"[on|off]",isEnabled:()=>pn(),get isHidden(){return!pn()},load:()=>Promise.resolve().then(() => (rwd(),twd))};
function Ol(e){return JSON.parse(e)}
function C(e,t){logs.push({message:e,options:t})}
function uL(e){return e}
function tHt(e){let t=process.env.CLAUDE_CODE_EXTRA_BODY,r={};if(t)try{let n=Ol(t);if(n&&typeof n==="object"&&!Array.isArray(n))r={...n};else C(\`CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given \${t}\`,{level:"error"})}catch(n){C(\`Error parsing CLAUDE_CODE_EXTRA_BODY: \${n.message}\`,{level:"error"})}if(e&&e.length>0){let n=uL(e);if(r.anthropic_beta&&Array.isArray(r.anthropic_beta)){let o=r.anthropic_beta,i=n.filter((s)=>!o.includes(s));r.anthropic_beta=[...o,...i]}else r.anthropic_beta=n}return r}
async function uea(e){return e}
async function BF_(e,t,r,n,o,i){let nm="proto",a="short",s="session",I=t,ye=r,w=["--resume"];let U={proto:nm,short:a,sessionId:s,respawnFlags:w,env:{...I,...ye.CLAUDE_CODE_EXTRA_BODY&&{CLAUDE_CODE_EXTRA_BODY:ye.CLAUDE_CODE_EXTRA_BODY},...ye.PATH&&{PATH:ye.PATH}},reattachEnv:o},[,Q]=await Promise.all([Promise.resolve(),uea(U)]);return Q}
`;

let nextPid = 41000;

function createFsFacade() {
  const facade = Object.create(fs);
  facade.failRename = false;
  facade.renameSync = (...args) => {
    if (facade.failRename) {
      throw new Error("rename failed");
    }
    return fs.renameSync(...args);
  };
  return facade;
}

function runtime(t, { env = {}, source = fixture, fsFacade = createFsFacade() } = {}) {
  const result = patchGatewayFastMode(source);
  assert.equal(result.candidates, 6);
  assert.equal(result.patched, 6);

  const modules = { fs: fsFacade, path, os, crypto };
  const fakeProcess = {
    env: { ...env },
    pid: nextPid++,
    getBuiltinModule(name) {
      return modules[name];
    },
    once() {},
  };
  const context = { console, process: fakeProcess };
  vm.createContext(context);
  vm.runInContext(result.content, context);

  const locator = context.process.env.CALICO_GATEWAY_FAST_STATE_FILE;
  if (locator && !env.CALICO_GATEWAY_FAST_STATE_FILE) {
    t.after(() => fs.rmSync(path.dirname(locator), { recursive: true, force: true }));
  }
  return { context, result, fsFacade };
}

function appState(options = {}) {
  return {
    getAppState() {
      return {};
    },
    setAppState() {},
    onQueryEvent() {},
    options: { fastMode: false, isNonInteractiveSession: false, ...options },
  };
}

function readMode(context) {
  return fs.readFileSync(context.process.env.CALICO_GATEWAY_FAST_STATE_FILE, "utf8");
}

function parsedEnv(context) {
  return JSON.parse(context.process.env.CLAUDE_CODE_EXTRA_BODY);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function renameToken(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(
    new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g"),
    to
  );
}

function fixture212() {
  return [
    ["uea", "Jia"],
    ["BF_", "GWy"],
    ["nm", "bm"],
    ["U", "J"],
    ["Q", "ne"],
  ].reduce((source, [from, to]) => renameToken(source, from, to), fixture);
}

test("remora interactive and thin commands toggle gateway priority without native Fast", async (t) => {
  const { context } = runtime(t, {
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: '{"keep":1}' },
  });
  let message;

  assert.equal(await context.Wj_((value) => (message = value), appState(), "on"), null);
  assert.match(message, /priority mode ON/);
  assert.deepEqual(parsedEnv(context), { keep: 1, service_tier: "priority" });
  assert.equal(readMode(context), "on");
  assert.deepEqual(plain(context.nativeCalls), []);
  assert.equal(context.pickerCalls, 0);

  const requestBody = plain(context.tHt(["beta-a"]));
  assert.deepEqual(requestBody, {
    keep: 1,
    service_tier: "priority",
    anthropic_beta: ["beta-a"],
  });
  assert.equal("speed" in requestBody, false);

  const off = await context.VPy("off", appState());
  assert.deepEqual(plain(off), {
    type: "text",
    value: "Gateway priority mode OFF (this session only)",
  });
  assert.deepEqual(parsedEnv(context), { keep: 1 });
  assert.equal(readMode(context), "off");

  await context.VPy("", appState());
  assert.equal(readMode(context), "on");
  await context.Wj_((value) => (message = value), appState(), "");
  assert.match(message, /priority mode OFF/);
  assert.equal(readMode(context), "off");
  assert.equal(context.pickerCalls, 0);

  const beforeEnv = context.process.env.CLAUDE_CODE_EXTRA_BODY;
  const beforeMode = readMode(context);
  const unknown = await context.VPy("later", appState());
  assert.match(unknown.value, /Unknown argument "later"/);
  assert.equal(context.process.env.CLAUDE_CODE_EXTRA_BODY, beforeEnv);
  assert.equal(readMode(context), beforeMode);
});

test("non-remora sessions preserve native gates, actions, picker, and registrations", async (t) => {
  const { context } = runtime(t);
  let message;

  await context.Wj_((value) => (message = value), appState(), "on");
  assert.equal(message, "Fast mode is not available");
  assert.deepEqual(plain(context.nativeCalls), []);
  assert.equal(context.zPy.isHidden, true);
  assert.equal(context.wSs.isEnabled(), false);
  assert.equal(context.wSs.isHidden, true);
  assert.equal(context.zPy.description, "Toggle fast mode (claude-opus-4-8)");

  context.nativeAvailable = true;
  await context.Wj_((value) => (message = value), appState(), "on");
  assert.equal(message, "Native Fast mode ON");
  assert.equal(context.nativeCalls.at(-1).source, "shortcut");

  const picker = await context.Wj_(() => undefined, appState(), "");
  assert.equal(picker.component, context.Gun);
  assert.equal(context.pickerCalls, 1);

  const thin = await context.VPy("", appState({ fastMode: true }));
  assert.equal(thin.value, "Native Fast mode OFF");
  assert.equal(context.nativeCalls.at(-1).source, "bridge");
  assert.equal(context.zPy.isHidden, false);
  assert.equal(context.wSs.isEnabled(), true);
  assert.equal(context.wSs.isHidden, false);
});

test("remora registrations stay visible and describe the gateway tier", (t) => {
  const { context } = runtime(t, { env: { REMORA_ACTIVE: "1" } });
  assert.equal(context.zPy.isHidden, false);
  assert.equal(context.wSs.isEnabled(), true);
  assert.equal(context.wSs.isHidden, false);
  assert.equal(context.zPy.description, "Toggle gateway priority tier");
  assert.equal(context.wSs.description, "Toggle gateway priority tier");
  assert.equal(context.zPy.thinClientDispatch, "control-request");
});

test("strict JSON handling preserves fields and enforces tier semantics", async (t) => {
  const accepted = runtime(t, {
    env: {
      REMORA_ACTIVE: "1",
      CLAUDE_CODE_EXTRA_BODY: String.raw`{"nested":{"ok":true},"service_tier":"fast"}`,
    },
  }).context;
  await accepted.VPy("on", appState());
  assert.deepEqual(parsedEnv(accepted), {
    nested: { ok: true },
    service_tier: "priority",
  });

  const literalEscape = runtime(t, {
    env: {
      REMORA_ACTIVE: "1",
      CLAUDE_CODE_EXTRA_BODY: String.raw`{"a":1,"\\u0061":2}`,
    },
  }).context;
  const literalResult = await literalEscape.VPy("on", appState());
  assert.match(literalResult.value, /priority mode ON/);
  assert.equal(parsedEnv(literalEscape).a, 1);
  assert.equal(parsedEnv(literalEscape)["\\u0061"], 2);

  const conflictingOff = runtime(t, {
    env: {
      REMORA_ACTIVE: "1",
      CLAUDE_CODE_EXTRA_BODY:
        '{"keep":{"service_tier":"nested"},"service_tier":"standard"}',
    },
  }).context;
  await conflictingOff.VPy("off", appState());
  assert.deepEqual(parsedEnv(conflictingOff), {
    keep: { service_tier: "nested" },
  });

  const blank = runtime(t, {
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: "   " },
  }).context;
  await blank.VPy("on", appState());
  assert.deepEqual(parsedEnv(blank), { service_tier: "priority" });
});

test("invalid JSON, duplicate keys, non-finite values, and conflicting on are atomic", async (t) => {
  const cases = [
    ['{"a":', /JSON|unexpected|unterminated/i],
    ["[]", /must be a JSON object/],
    [
      '{"outer":{"a":1,"' + String.fromCharCode(92) + 'u0061":2}}',
      /duplicate JSON key/,
    ],
    ['{"value":NaN}', /JSON|unexpected/i],
    ['{"value":Infinity}', /JSON|unexpected/i],
    ['{"value":-Infinity}', /JSON|unexpected/i],
    ['{"value":1e9999}', /non-finite/],
    ['{"service_tier":"standard","keep":1}', /service_tier/],
  ];

  for (const [body, errorPattern] of cases) {
    const { context } = runtime(t, {
      env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: body },
    });
    const beforeMode = readMode(context);
    const result = await context.VPy("on", appState());
    assert.match(result.value, errorPattern, body);
    assert.equal(context.process.env.CLAUDE_CODE_EXTRA_BODY, body, body);
    assert.equal(readMode(context), beforeMode, body);
  }
});

test("bare inherit derives current state from the strict body", async (t) => {
  const inheritedOn = runtime(t, {
    env: {
      REMORA_ACTIVE: "1",
      CLAUDE_CODE_EXTRA_BODY: '{"keep":1,"service_tier":"priority"}',
    },
  }).context;
  assert.equal(readMode(inheritedOn), "inherit");
  assert.equal(plain(inheritedOn.tHt([])).service_tier, "priority");
  await inheritedOn.VPy("", appState());
  assert.equal(readMode(inheritedOn), "off");
  assert.deepEqual(parsedEnv(inheritedOn), { keep: 1 });

  const inheritedOff = runtime(t, {
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: '{"keep":2}' },
  }).context;
  await inheritedOff.VPy("", appState());
  assert.equal(readMode(inheritedOff), "on");
  assert.deepEqual(parsedEnv(inheritedOff), { keep: 2, service_tier: "priority" });
});

test("existing, new, and respawned workers read the shared mode on every request", async (t) => {
  const main = runtime(t, {
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: '{"main":1}' },
  }).context;
  const locator = main.process.env.CALICO_GATEWAY_FAST_STATE_FILE;
  const workerEnv = {
    REMORA_ACTIVE: "1",
    CALICO_GATEWAY_FAST_STATE_FILE: locator,
    CLAUDE_CODE_EXTRA_BODY: '{"worker":1,"service_tier":"stale"}',
  };
  const existingWorker = runtime(t, { env: workerEnv }).context;

  await main.VPy("on", appState());
  assert.deepEqual(plain(existingWorker.tHt([])), {
    worker: 1,
    service_tier: "priority",
  });

  const dispatch = await main.BF_(null, { BASE: "1" }, main.process.env);
  assert.equal(dispatch.env.CALICO_GATEWAY_FAST_STATE_FILE, locator);
  const newWorker = runtime(t, {
    env: { ...workerEnv, ...dispatch.env, CLAUDE_CODE_EXTRA_BODY: '{"new":1}' },
  }).context;
  assert.equal(plain(newWorker.tHt([])).service_tier, "priority");

  await main.VPy("off", appState());
  assert.deepEqual(plain(existingWorker.tHt([])), { worker: 1 });
  assert.deepEqual(plain(newWorker.tHt([])), { new: 1 });

  const respawned = runtime(t, {
    env: {
      ...workerEnv,
      CALICO_GATEWAY_FAST_STATE_FILE: dispatch.env.CALICO_GATEWAY_FAST_STATE_FILE,
      CLAUDE_CODE_EXTRA_BODY: '{"respawn":1,"service_tier":"old"}',
    },
  }).context;
  assert.deepEqual(plain(respawned.tHt([])), { respawn: 1 });
});

test("state read failures abort request-time body construction", async (t) => {
  const { context } = runtime(t, {
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: '{"service_tier":"priority"}' },
  });
  const locator = context.process.env.CALICO_GATEWAY_FAST_STATE_FILE;

  fs.writeFileSync(locator, "invalid", "utf8");
  assert.throws(() => context.tHt([]), /state is invalid/);

  fs.unlinkSync(locator);
  assert.throws(() => context.tHt([]), /ENOENT/);

  const unreadablePath = path.dirname(locator);
  const unreadable = runtime(t, {
    env: {
      REMORA_ACTIVE: "1",
      CALICO_GATEWAY_FAST_STATE_FILE: unreadablePath,
      CLAUDE_CODE_EXTRA_BODY: '{"service_tier":"priority"}',
    },
  }).context;
  assert.throws(() => unreadable.tHt([]), /EISDIR|illegal operation|directory/i);
});

test("rename failure restores the exact env string and old mode", async (t) => {
  const fsFacade = createFsFacade();
  const originalBody = '{ "keep" : 1 }';
  const { context } = runtime(t, {
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: originalBody },
    fsFacade,
  });
  const locator = context.process.env.CALICO_GATEWAY_FAST_STATE_FILE;
  fsFacade.failRename = true;

  const result = await context.VPy("on", appState());
  assert.match(result.value, /rename failed/);
  assert.equal(context.process.env.CLAUDE_CODE_EXTRA_BODY, originalBody);
  assert.equal(readMode(context), "inherit");
  assert.deepEqual(fs.readdirSync(path.dirname(locator)), ["mode"]);
});

test("matches renamed identifiers", async (t) => {
  const renamed = [
    ["Wj_", "Qj_"],
    ["VPy", "KPy"],
    ["zPy", "aPy"],
    ["wSs", "bSs"],
    ["tHt", "qHt"],
    ["BF_", "RF_"],
    ["sl", "gate"],
    ["IDe", "reason"],
    ["jTo", "nativeSet"],
    ["R9", "modelLabel"],
    ["e", "argE"],
    ["t", "ctxT"],
    ["r", "argR"],
  ].reduce((source, [from, to]) => renameToken(source, from, to), fixture);
  const { context } = runtime(t, {
    source: renamed,
    env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: "{}" },
  });

  const result = await context.KPy("on", appState());
  assert.match(result.value, /priority mode ON/);
  assert.equal(plain(context.qHt([])).service_tier, "priority");
});

test("accepts 2.1.211 and 2.1.212 worker dispatch symbols through record ownership", async (t) => {
  for (const [source, functionName] of [
    [fixture, "BF_"],
    [fixture212(), "GWy"],
  ]) {
    const { context } = runtime(t, {
      source,
      env: { REMORA_ACTIVE: "1", CLAUDE_CODE_EXTRA_BODY: "{}" },
    });
    const dispatch = await context[functionName](null, { BASE: "1" }, context.process.env);
    assert.equal(
      dispatch.env.CALICO_GATEWAY_FAST_STATE_FILE,
      context.process.env.CALICO_GATEWAY_FAST_STATE_FILE
    );
  }
});

test("rejects detached, indirect, wrong-record, and duplicate worker dispatches", () => {
  const workerEnv =
    "...ye.CLAUDE_CODE_EXTRA_BODY&&{CLAUDE_CODE_EXTRA_BODY:ye.CLAUDE_CODE_EXTRA_BODY},...ye.PATH&&{PATH:ye.PATH}";
  const brokenFixtures = [
    fixture.replace("uea(U)", "uea(J)"),
    fixture.replace(
      "},[,Q]=await Promise.all([Promise.resolve(),uea(U)]);return Q",
      "};let Q=await uea(U);return Q"
    ),
    fixture.replace(
      "uea(U)",
      "Promise.resolve().then(()=>uea(U))"
    ),
    fixture.replace(
      `env:{...I,${workerEnv}},reattachEnv:o`,
      `env:{...I},detachedEnv:{${workerEnv}},reattachEnv:o`
    ),
    fixture.replace(
      "return Q}",
      "await uea(U);return Q}"
    ),
  ];

  for (const broken of brokenFixtures) {
    const result = patchGatewayFastMode(broken);
    assert.notEqual(broken, fixture);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
  }
});

test("fails atomically when a required anchor is missing or duplicated", () => {
  const brokenFixtures = [
    fixture.replace("async function Wj_", "async function_changed Wj_"),
    fixture.replace("async function VPy", "async function_changed VPy"),
    fixture.replace('type:"local-jsx",name:"fast"', 'type:"local-jsx",name:"slow"'),
    fixture.replace('type:"local",name:"fast"', 'type:"local",name:"slow"'),
    fixture.replace("process.env.CLAUDE_CODE_EXTRA_BODY,r={}", "process.env.EXTRA_BODY,r={}"),
    fixture.replace(
      "...ye.CLAUDE_CODE_EXTRA_BODY&&{CLAUDE_CODE_EXTRA_BODY:ye.CLAUDE_CODE_EXTRA_BODY}",
      "...ye.EXTRA_BODY&&{EXTRA_BODY:ye.EXTRA_BODY}"
    ),
    fixture + fixture,
  ];

  for (const broken of brokenFixtures) {
    const result = patchGatewayFastMode(broken);
    assert.equal(result.patched, 0);
    assert.equal(result.content, broken);
    assert.equal(result.content.includes("__calicoGatewayFastEnsure"), false);
  }
});

test("binary verifier accepts the complete gateway fast-mode structure", () => {
  const patched = patchGatewayFastMode(fixture).content;
  assert.equal(evaluatePatchModule("gateway-fast-mode", patched), null);
});

test("binary verifier rejects detached helpers and broken gateway ownership", () => {
  const patched = patchGatewayFastMode(fixture).content;
  const helperStart = patched.indexOf("var __calicoGatewayFastNode=");
  const interactiveStart = patched.indexOf("async function Wj_", helperStart);
  const helperBlock = patched.slice(helperStart, interactiveStart);
  const applyHelper = helperBlock.match(
    /function __calicoGatewayFastApply[\s\S]*$/
  )?.[0];
  const builderStart = patched.indexOf("function tHt(");
  const builderEnd = patched.indexOf("async function uea", builderStart);
  assert.ok(applyHelper);
  assert.notEqual(builderStart, -1);
  assert.ok(builderEnd > builderStart);
  const builderBlock = patched.slice(builderStart, builderEnd);

  const commentOnlyHelpers =
    patched.slice(0, helperStart) +
    `/*${helperBlock}*/` +
    patched.slice(interactiveStart);
  const alternateApply = patched.replace(
    applyHelper,
    `var __calicoGatewayFastApply=()=>{};/*${applyHelper}*/`
  );
  const withoutThinBranch = patched.replace(
    'if(process.env.REMORA_ACTIVE==="1")return __calicoGatewayFastThin(e);',
    ""
  );
  const withoutNativeAction = patched.replace('"shortcut"', '"shortcut-broken"');
  const applyAfterBetaMerge = patched.replace(
    builderBlock,
    builderBlock
      .replace("r=__calicoGatewayFastApply(r);", "")
      .replace("return r}", "r=__calicoGatewayFastApply(r);return r}")
  );
  const applyBeforeNativeParse = patched
    .replace(
      "r=__calicoGatewayFastApply(r);if(e&&e.length>0){",
      "if(e&&e.length>0){"
    )
    .replace(
      "function tHt(e){let t=process.env.CLAUDE_CODE_EXTRA_BODY,r={};",
      "function tHt(e){let t=process.env.CLAUDE_CODE_EXTRA_BODY,r={};r=__calicoGatewayFastApply(r);"
    );
  const applyInsideNativeCatch = patched.replace(
    ',{level:"error"})}r=__calicoGatewayFastApply(r);',
    ',{level:"error"});r=__calicoGatewayFastApply(r)}'
  );
  const withoutWorkerLocator = patched.replace(
    ",...ye.CALICO_GATEWAY_FAST_STATE_FILE&&{CALICO_GATEWAY_FAST_STATE_FILE:ye.CALICO_GATEWAY_FAST_STATE_FILE}",
    ""
  );
  const nativeOnlyRegistration = patched.replace(
    'process.env.REMORA_ACTIVE==="1"?"Toggle gateway priority tier":',
    ""
  );
  const wrongVisibilityOwner = patched.replace(
    'process.env.REMORA_ACTIVE==="1"?!1:!sl()',
    'process.env.REMORA_ACTIVE==="1"?!1:!pn()'
  );
  const injectedAnthropicSpeed = patched.replace(
    "function __calicoGatewayFastApply",
    'var __calicoGatewayFastLeak={speed:"fast"};function __calicoGatewayFastApply'
  );
  const injectedBuilderSpeed = patched.replace(
    "r=__calicoGatewayFastApply(r);if(e&&e.length>0){",
    'r=__calicoGatewayFastApply(r);r.speed="fast";if(e&&e.length>0){'
  );
  const persistedExtraBody = patched.replace(
    "writeFileSync(l,e,{encoding:",
    "writeFileSync(l,t,{encoding:"
  );
  const staleThinToggle = patched.replace(".options.fastMode", ".options.fastModeBroken");
  const workerEnvPair =
    ",...ye.CLAUDE_CODE_EXTRA_BODY&&{CLAUDE_CODE_EXTRA_BODY:ye.CLAUDE_CODE_EXTRA_BODY},...ye.CALICO_GATEWAY_FAST_STATE_FILE&&{CALICO_GATEWAY_FAST_STATE_FILE:ye.CALICO_GATEWAY_FAST_STATE_FILE},...ye.PATH&&{PATH:ye.PATH}";
  const detachedWorkerEnv = patched.replace(
    `env:{...I${workerEnvPair}},reattachEnv:o`,
    `env:{...I},detachedEnv:{${workerEnvPair.slice(1)}},reattachEnv:o`
  );
  const wrongDispatchRecord = patched.replace("uea(U)", "uea(J)");
  const dispatchOutsidePromiseAll = patched.replace(
    "},[,Q]=await Promise.all([Promise.resolve(),uea(U)]);return Q",
    "};let Q=await uea(U);return Q"
  );
  const callbackDeferredDispatch = patched.replace(
    "uea(U)",
    "Promise.resolve().then(()=>uea(U))"
  );
  const duplicateDispatch = patched.replace("return Q}", "await uea(U);return Q}");

  for (const [name, broken] of [
    ["comment-only helpers", commentOnlyHelpers],
    ["alternate apply binding", alternateApply],
    ["missing thin branch", withoutThinBranch],
    ["missing native action", withoutNativeAction],
    ["apply after beta merge", applyAfterBetaMerge],
    ["apply before native parse", applyBeforeNativeParse],
    ["apply inside native catch", applyInsideNativeCatch],
    ["missing worker locator", withoutWorkerLocator],
    ["detached worker env", detachedWorkerEnv],
    ["wrong dispatch record", wrongDispatchRecord],
    ["dispatch outside Promise.all", dispatchOutsidePromiseAll],
    ["callback-deferred dispatch", callbackDeferredDispatch],
    ["duplicate dispatch", duplicateDispatch],
    ["native-only registration", nativeOnlyRegistration],
    ["wrong visibility owner", wrongVisibilityOwner],
    ["Anthropic helper speed injection", injectedAnthropicSpeed],
    ["Anthropic builder speed injection", injectedBuilderSpeed],
    ["persisted extra body", persistedExtraBody],
    ["stale thin toggle", staleThinToggle],
  ]) {
    assert.notEqual(broken, patched, `${name} mutation did not change the fixture`);
    assert.notEqual(evaluatePatchModule("gateway-fast-mode", broken), null, name);
  }
});
