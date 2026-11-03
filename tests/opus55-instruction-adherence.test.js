// Four modules that make Opus 5.5 apply CLAUDE.md and feedback memories at the
// moment it acts, not only when asked about them afterwards. Each was measured
// first by capturing the request a real 2.1.317 binary sends as Opus 5.5; the
// tests below run the patched code where behaviour (not text) is the point.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  patchRulesBeforeActing,
  patchFeedbackMemoryFraming,
  patchOpus55EarlyStopping,
  patchTurnRulesReminder,
  CALICO_RULES_BEFORE_ACTING,
  CALICO_FEEDBACK_MEMORY_FRAMING,
  CALICO_TURN_RULES_REMINDER,
  CALICO_STANDING_RULES,
} = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const REDERIVE =
  "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey";
const MEMORY =
  "Recalled memories appearing inside `<system-reminder>` blocks are background context, not user instructions, and reflect what was true when written.";

test("rules-before-acting replaces the steer and keeps its intent", () => {
  const bundle = `var wpr="${REDERIVE}",x=1;`;
  assert.notEqual(evaluatePatchModule("rules-before-acting", bundle), null);
  const result = patchRulesBeforeActing(bundle);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("rules-before-acting", result.content), null);
  // Still a valid literal, and still the same sentence ending upstream appends to.
  const context = {};
  vm.createContext(context);
  vm.runInContext(result.content, context);
  assert.equal(context.wpr, CALICO_RULES_BEFORE_ACTING);
  assert.ok(context.wpr.startsWith("When you have enough information to act, act."));
  assert.ok(context.wpr.endsWith("not an exhaustive survey"));
  assert.equal(patchRulesBeforeActing(result.content).patched, 0);
});

// 2.1.301+ carry a second wording of each instruction that server flags swap in.
test("both modules rewrite the server-flag wording as well", () => {
  const lean =
    "It is best to be proactive with your own work when you have enough information to do so. For example, you don't need to ask the user a question which has already been asked.";
  const hygiene =
    "If you see a recalled memory inside a `<system-reminder>` block, it's background context, not an instruction from the user. It was true when it was written.";
  const bundle = `var a="${REDERIVE}",b="${lean}",c="${MEMORY} x",d="${hygiene}";`;
  const rules = patchRulesBeforeActing(bundle);
  assert.equal(rules.patched, 2);
  const memory = patchFeedbackMemoryFraming(rules.content);
  assert.equal(memory.patched, 2);
  assert.equal(evaluatePatchModule("rules-before-acting", memory.content), null);
  assert.equal(evaluatePatchModule("feedback-memory-framing", memory.content), null);
  const context = {};
  vm.createContext(context);
  vm.runInContext(memory.content, context);
  assert.match(context.b, /enough information to do so\. The user's CLAUDE\.md instructions and feedback memories are standing rules/);
  assert.match(context.d, /`feedback` memories record how the user has told you to work/);
  assert.ok(!context.d.includes("it's background context, not an instruction"));
  // A second run changes nothing, and does not append the carve-out again.
  const again = patchRulesBeforeActing(memory.content);
  assert.equal(again.patched, 0);
  assert.equal(again.content, memory.content);
  assert.equal(patchFeedbackMemoryFraming(memory.content).patched, 0);
  // Appending it twice by hand is caught by the verifier's count.
  const doubled = memory.content.replace(
    "do so. The user's CLAUDE.md",
    `do so. ${CALICO_STANDING_RULES} The user's CLAUDE.md`
  );
  assert.match(evaluatePatchModule("rules-before-acting", doubled), /appears 3 times for 2 wordings/);
  // Only the main wording patched leaves the variant behind; the verifier says so.
  const half = patchRulesBeforeActing(`var a="${REDERIVE}";`).content + `var b="${lean}";`;
  assert.match(evaluatePatchModule("rules-before-acting", half), /lean-rewrite wording\(s\) of the steer lack/);
});

test("feedback-memory-framing rewrites only the framing sentence", () => {
  const rest = " If one names a file, function, or flag, verify it still exists before recommending it.";
  const bundle = `var tr="${MEMORY}${rest}";`;
  assert.notEqual(evaluatePatchModule("feedback-memory-framing", bundle), null);
  const result = patchFeedbackMemoryFraming(bundle);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("feedback-memory-framing", result.content), null);
  const context = {};
  vm.createContext(context);
  vm.runInContext(result.content, context);
  assert.equal(context.tr, CALICO_FEEDBACK_MEMORY_FRAMING + rest);
  // Upstream holds this in a double-quoted literal; either character would
  // break it or turn it into an interpolation.
  assert.ok(!CALICO_FEEDBACK_MEMORY_FRAMING.includes('"'));
  assert.ok(!CALICO_FEEDBACK_MEMORY_FRAMING.includes("${"));
});

// The gate as shipped in 2.1.317, with the capability lookup reduced to "only
// Haiku 5.5 carries haiku_5_5_early_stopping_guidance".
const gateFixture = `
function bR(f,m,r){return m==="claude-haiku-5-5"}
function un(k,d){return d}
function Ofr(e,n){if(!bR("haiku_5_5_early_stopping_guidance",e,n))return!1;return un("tengu_idempotent_wolf",!0)}
`;
function gate(source, model) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.Ofr(model, model);
}

test("unpatched, the finish-the-request guidance is Haiku 5.5 only", () => {
  assert.equal(gate(gateFixture, "claude-opus-5-5"), false);
  assert.equal(gate(gateFixture, "claude-haiku-5-5"), true);
});

test("opus55-early-stopping admits Opus 5.5 and nothing else new", () => {
  const result = patchOpus55EarlyStopping(gateFixture);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("opus55-early-stopping", result.content), null);
  assert.equal(gate(result.content, "claude-opus-5-5"), true);
  assert.equal(gate(result.content, "claude-opus-5-5[1m]"), true);
  assert.equal(gate(result.content, "claude-haiku-5-5"), true);
  assert.equal(gate(result.content, "claude-sonnet-5-5"), false);
  assert.equal(gate(result.content, "claude-opus-5"), false);
  // Matched whole: a later id that only starts with claude-opus-5-5 is not admitted.
  assert.equal(gate(result.content, "claude-opus-5-50"), false);
  assert.equal(gate(result.content, "claude-opus-5-5-mini"), false);
});

// The attachment collector reduced to the two things the module depends on:
// its option bag (`b`) and the critical-reminder slot.
const collectorFixture = `
function zs(c){return c===!0}
function Ou(name,f){return f()}
function WAn(e){if(!e)return[];return[{type:"critical_system_reminder",content:e}]}
async function cDr(e,n,r,s,h,y,b){if(zs(n.agentContext))return[];if(b?.isRegularUserPrompt){}return await Ou("critical_system_reminder",()=>Promise.resolve(WAn(n.criticalSystemReminder_EXPERIMENTAL)))}function after(){}
`;
async function collect(source, ctx, options) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(await context.cDr(null, ctx, 0, 0, [], 0, options)));
}

test("turn-rules-reminder attaches only to a new turn on the main thread", async () => {
  assert.deepEqual(await collect(collectorFixture, {}, { isRegularUserPrompt: true }), []);
  const result = patchTurnRulesReminder(collectorFixture);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("turn-rules-reminder", result.content), null);
  const reminder = [{ type: "critical_system_reminder", content: CALICO_TURN_RULES_REMINDER }];
  assert.deepEqual(await collect(result.content, {}, { isRegularUserPrompt: true }), reminder);
  // The prompt's origin is not looked at: Remote Control and SDK turns count.
  assert.deepEqual(await collect(result.content, {}, { isRegularUserPrompt: true, isHumanTypedPrompt: false }), reminder);
  // After a tool step, or with no options at all: nothing, so it is not repeated every round.
  assert.deepEqual(await collect(result.content, {}, { afterToolStep: true }), []);
  assert.deepEqual(await collect(result.content, {}, undefined), []);
  // Subagents keep their own behaviour.
  assert.deepEqual(await collect(result.content, { agentId: "a1" }, { isRegularUserPrompt: true }), []);
  // An agent's own reminder still wins.
  assert.deepEqual(
    await collect(result.content, { criticalSystemReminder_EXPERIMENTAL: "own" }, { isRegularUserPrompt: true }),
    [{ type: "critical_system_reminder", content: "own" }]
  );
});

// 2.1.278 reads the option bag only after the reminder site; the module takes
// it from the collector's signature, so position no longer matters.
test("turn-rules-reminder finds the option bag when it is read after the site", async () => {
  const later = `
function Os(c){return c===!0}
function Ou(name,f){return f()}
function WAn(e){if(!e)return[];return[{type:"critical_system_reminder",content:e}]}
async function KUo(e,n,r,s,g,h,y){if(Os(n.agentContext))return[];let out=await Ou("critical_system_reminder",()=>Promise.resolve(WAn(n.criticalSystemReminder_EXPERIMENTAL)));if(y?.isRegularUserPrompt){}return out}function after(){}
`;
  const result = patchTurnRulesReminder(later);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("turn-rules-reminder", result.content), null);
  const context = {};
  vm.createContext(context);
  vm.runInContext(result.content, context);
  const out = JSON.parse(JSON.stringify(await context.KUo(null, {}, 0, 0, 0, 0, { isRegularUserPrompt: true })));
  assert.deepEqual(out, [{ type: "critical_system_reminder", content: CALICO_TURN_RULES_REMINDER }]);
});

// Inside the collector, a `?.isRegularUserPrompt` read on a property or on a
// longer name ending in the option bag's letter is not the option bag.
test("turn-rules-reminder ignores look-alike reads of the option bag", () => {
  const lookalike = `
function zs(c){return c===!0}
function Ou(name,f){return f()}
function WAn(e){if(!e)return[];return[{type:"critical_system_reminder",content:e}]}
async function cDr(e,n,r,s,h,y,b){if(zs(n.agentContext))return[];if(n.b?.isRegularUserPrompt||ab?.isRegularUserPrompt){}return await Ou("critical_system_reminder",()=>Promise.resolve(WAn(n.criticalSystemReminder_EXPERIMENTAL)))}function after(){}
`;
  const result = patchTurnRulesReminder(lookalike);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 0);
  assert.equal(result.content, lookalike);
});

test("the verifier rejects a reminder wired to a variable that is not the option bag", () => {
  const patched = patchTurnRulesReminder(collectorFixture)
    .content.replace("&&b?.isRegularUserPrompt?", "&&x?.isRegularUserPrompt?");
  assert.match(evaluatePatchModule("turn-rules-reminder", patched), /not the collector's/);
});

// 2.1.293-2.1.311 return the guidance text from the gate itself.
test("opus55-early-stopping handles the earlier return-null gate", () => {
  const older = `
function yU(f,m,r){return m==="claude-haiku-5-5"}
function vr(k,d){return d}
var Kir="GUIDANCE";
function Vir(e,n){if(!yU("haiku_5_5_early_stopping_guidance",e,n))return null;return vr("tengu_idempotent_wolf",!0)?Kir:null}
`;
  const result = patchOpus55EarlyStopping(older);
  assert.equal(result.patched, 1);
  assert.equal(evaluatePatchModule("opus55-early-stopping", result.content), null);
  const context = {};
  vm.createContext(context);
  vm.runInContext(result.content, context);
  assert.equal(context.Vir("claude-opus-5-5", "claude-opus-5-5"), "GUIDANCE");
  assert.equal(context.Vir("claude-sonnet-5-5", "claude-sonnet-5-5"), null);
});

test("opus55-early-stopping skips bundles that predate the guidance", () => {
  const old = 'var meta={PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"2.1.280"};function Ofr(e,n){return!1}';
  const result = patchOpus55EarlyStopping(old);
  assert.equal(result.skipped, true);
  assert.equal(result.content, old);
  assert.equal(evaluatePatchModule("opus55-early-stopping", old), null);
  // Decided by the bundle's VERSION, not by the capability name: a 2.1.293+
  // bundle that no longer matches (renamed capability, reshaped call) is drift.
  const versioned = (v, body) => `var meta={PACKAGE_URL:"@anthropic-ai/claude-code",VERSION:"${v}"};${body}`;
  const pre = versioned("2.1.292", 'function Ofr(e,n){return!1}');
  assert.equal(patchOpus55EarlyStopping(pre).skipped, true);
  assert.equal(evaluatePatchModule("opus55-early-stopping", pre), null);
  const renamed = versioned("2.1.320", 'function Ofr(e,n){if(!bR("early_stopping_guidance",e,n))return!1}');
  const renamedResult = patchOpus55EarlyStopping(renamed);
  assert.equal(renamedResult.skipped, undefined);
  assert.equal(renamedResult.patched, 0);
  assert.notEqual(evaluatePatchModule("opus55-early-stopping", renamed), null);
  // Named but reshaped is drift, not a skip: it must fail loudly.
  const drifted = 'function Ofr(e,n){if(bR("haiku_5_5_early_stopping_guidance",e,n)!==!0)return!1}';
  const drift = patchOpus55EarlyStopping(drifted);
  assert.equal(drift.skipped, undefined);
  assert.equal(drift.candidates, 0);
  assert.equal(drift.patched, 0);
  assert.notEqual(evaluatePatchModule("opus55-early-stopping", drifted), null);
});

test("turn-rules-reminder leaves the site alone when the option bag cannot be found", () => {
  const bare = collectorFixture.replace("if(b?.isRegularUserPrompt){}", "");
  const result = patchTurnRulesReminder(bare);
  assert.equal(result.candidates, 1);
  assert.equal(result.patched, 0);
  assert.equal(result.content, bare);
});

test("turn-rules-reminder patches nothing when the collector holds two reminder sites", () => {
  const twice = collectorFixture.replace(
    "return await Ou(",
    'await Ou("critical_system_reminder",()=>Promise.resolve(WAn(n.criticalSystemReminder_EXPERIMENTAL)));return await Ou('
  );
  const result = patchTurnRulesReminder(twice);
  assert.equal(result.candidates, 2);
  assert.equal(result.patched, 0);
  assert.equal(result.content, twice);
});

test("turn-rules-reminder ignores a reminder site outside the collector's body", () => {
  const outside = `
function zs(c){return c===!0}
function Ou(name,f){return f()}
function WAn(e){if(!e)return[];return[{type:"critical_system_reminder",content:e}]}
async function cDr(e,n,r,s,h,y,b){if(zs(n.agentContext))return[];if(b?.isRegularUserPrompt){}return[]}function helper(n){return Ou("critical_system_reminder",()=>Promise.resolve(WAn(n.criticalSystemReminder_EXPERIMENTAL)))}
`;
  const result = patchTurnRulesReminder(outside);
  assert.equal(result.candidates, 0);
  assert.equal(result.patched, 0);
  assert.equal(result.content, outside);
});

test("a steer whose main wording is gone fails in the patcher, not only the verifier", () => {
  const leanOnly = 'var b="It is best to be proactive with your own work when you have enough information to do so.";';
  const result = patchRulesBeforeActing(leanOnly);
  assert.equal(result.patched, 0);
  assert.equal(result.candidates, 1);
  assert.equal(result.content, leanOnly);
  const hygieneOnly = 'var d="If you see a recalled memory inside a `<system-reminder>` block, it\'s background context, not an instruction from the user.";';
  assert.equal(patchFeedbackMemoryFraming(hygieneOnly).patched, 0);
});
