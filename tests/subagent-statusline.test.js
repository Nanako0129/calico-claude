// subagent-statusline restores the subagentStatusLine command that upstream
// removed in 2.1.323. The fixtures copy the 2.1.323 shapes the module anchors on:
// the statusLine runner chunk (runner, managed-only reader, payload builder)
// and the agent-panel chunk (panel call site, row component, ANSI helper),
// joined by the Bun module boundary the native reader inserts.
//
// The runner chunk is executed in a vm with stubs for every upstream binding,
// so the gate is tested as behaviour. The row is mounted through real React
// (ink), so a hook-order change between the two branches would throw.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const { patchSubagentStatusLine } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");
const { BUN_MODULE_BOUNDARY } = require("../scripts/native-bun.ts");

// ---------------------------------------------------------------------------
// Runner chunk (2.1.323 shapes, stubs above the copied code).
// ---------------------------------------------------------------------------
const runnerStubs = `
var FLAGS={hooksOff:!1,statusLineOff:!1,untrusted:!1,safeMode:!1,allowManagedHooksOnly:!1,userDisableAllHooks:!1},SETTINGS={},POLICY=void 0,LOGS=[],EXECS=[];
var EXEC_RESULT=(cfg,input,signal)=>({status:0,stdout:"",stderr:"",aborted:!1});
var settingsSchema={subagentStatusLine:()=>({})};
function ng(){return FLAGS.hooksOff}
function br(e){return e==="statusLine"&&FLAGS.statusLineOff}
function lq(){return FLAGS.untrusted}
function t(e){LOGS.push(String(e))}
function g(){}function m(){}
function Pr(){return SETTINGS}
function $b(){return FLAGS.safeMode||FLAGS.allowManagedHooksOnly}function Fb(){return FLAGS.userDisableAllHooks}
function ye(e){return e==="policySettings"?POLICY:void 0}
var TAGGED=new WeakSet;function QW(e){return TAGGED.add(e),e}
function _(e){return JSON.stringify(e)}
function qxs(e){return e.remote===!0}function k4(e){return"redacted"}
function zRe(e){return{fromPayload:e.session_id}}function Qo(e){return{project:e.id}}function hE(){return"hook-id"}
async function zz(e,n,r,s,h,y,E,v,H,q,X){EXECS.push({cfg:e,tagged:TAGGED.has(e),event:n,key:r,input:s,fifth:h,payloadArg:y,sessionArg:E,cwd:v,signal:H,hookId:q,hidden:X});return EXEC_RESULT(e,s,H)}
class W{constructor(f){this.f=f;this.m=new Map}of(k){if(!this.m.has(k))this.m.set(k,this.f());return this.m.get(k)}}
function bbt(e,n){return{context_window_size:n}}
function Im(){return["beta"]}
`;

const runnerChunk =
  runnerStubs +
  `var Mve=new WeakSet;function lnn(){return $b()||Fb()}function kDt(e){return lnn()?ye("policySettings")?.statusLine:e}function J8e(e){try{return ye("policySettings")?.[e]!==void 0}catch{return!0}}` +
  `function R_(e,n){return e.includes("[1m]")?1e6:200000}` +
  `class A8n{okLogged=!1;badLogged=!1}var Ius=new W(()=>new A8n);async function aho(e,n,r,s=!1){if(ng())return;let h=Ius.of(e.host);if(br("statusLine"))return;if(lq()){t("Skipping StatusLine command execution - workspace trust not accepted");return}let y=kDt(Pr()?.statusLine);if(!y||y.type!=="command")return;try{let E=_(n),v=Date.now(),H=qxs(e)?k4(y):void 0,q=H===void 0?y.command:"command left out",X=await zz(J8e("statusLine")?QW({...y}):y,"StatusLine","statusLine",E,void 0,zRe(n),Qo(e),n.cwd,r,hE(),H);if(X.aborted)return;let ne=X.stderr.trim();if(ne)t(\`StatusLine [\${q}] stderr: \${ne}\`);if(X.status===0){if(!h.okLogged)h.okLogged=!0,g("status_line_command");let ke=X.stdout.trim();if(ke){if(s)t(\`StatusLine [\${q}] completed with status \${X.status}\`);return ke}}return}catch(E){if(t(\`Status hook failed: \${E}\`,{level:"error"}),!h.badLogged)h.badLogged=!0,m("status_line_command","exec_error");return}}` +
  `function Qcs({session:e,mainLoopModel:v,cwd:Ee}){let nt=v,rt=null,gt=R_(nt,Im()),wt=e.name;return{session_id:e.id,transcript_path:"/transcripts/"+e.id+".jsonl",cwd:Ee,model:{id:nt,display_name:nt},workspace:{current_dir:Ee},context_window:bbt(rt,gt),exceeds_200k_tokens:!1}}`;

// ---------------------------------------------------------------------------
// Panel chunk (2.1.323 row component copied verbatim; panel reduced to the
// shapes the module anchors on).
// ---------------------------------------------------------------------------
const rowComponent =
  'function xue(h){let qt=E(73),{task:P,name:M,link:H,labelWidth:ee,statusWidth:xe,statusParts:Ie,isSelected:$e,isViewed:Ge,treeConnector:Ye,descendantSuffix:Ze,onClick:rt}=h,[bt,Pt]=y(!1),Mt=aM(rt),{elapsed:Dt,tokenText:Ut,queuedText:jt,queuedCount:Ft}=Ie,to;if(qt[0]!==P.description||qt[1]!==P.progress?.summary)to=qr(P.progress?.summary??"")||qr(P.description),qt[0]=P.description,qt[1]=P.progress?.summary,qt[2]=to;else to=qt[2];let eo=to,oo=$e||bt,ro=oo?se.pointer+" ":"  ",so=Ge?cs:se.circle,lo;if(qt[3]!==P)lo=_N(P)?void 0:Kz(P.status),qt[3]=P,qt[4]=lo;else lo=qt[4];let po=lo,fo=!oo&&!Ge,uo;if(qt[5]!==fo||qt[6]!==Ge||qt[7]!==ro)uo=e(n,{dimColor:fo,bold:Ge,children:ro}),qt[5]=fo,qt[6]=Ge,qt[7]=ro,qt[8]=uo;else uo=qt[8];let wo;if(qt[9]!==fo||qt[10]!==Ye)wo=Ye!==void 0&&e(n,{dimColor:fo,children:Ye}),qt[9]=fo,qt[10]=Ye,qt[11]=wo;else wo=qt[11];const yo=!po&&fo;let To;if(qt[12]!==so||qt[13]!==po||qt[14]!==Ge||qt[15]!==yo)To=r(n,{color:po,dimColor:yo,bold:Ge,children:[so," "]}),qt[12]=so,qt[13]=po,qt[14]=Ge,qt[15]=yo,qt[16]=To;else To=qt[16];let Ro;if(qt[17]!==uo||qt[18]!==wo||qt[19]!==To)Ro=r(ne,{children:[uo,wo,To]}),qt[17]=uo,qt[18]=wo,qt[19]=To,qt[20]=Ro;else Ro=qt[20];let Io=Ro,qo;if(qt[21]!==Ye)qo=Ye?re(Ye):0,qt[21]=Ye,qt[22]=qo;else qo=qt[22];let dn=qo,tn=tk()+dn,Po=Math.max(0,ee-dn),Eo,Fo;if(qt[23]===v)Fo=()=>Pt(!0),Eo=()=>Pt(!1),qt[23]=Eo,qt[24]=Fo;else Eo=qt[23],Fo=qt[24];let Dn;if(qt[25]!==Io||qt[26]!==tn)Dn=e(s,{width:tn,flexShrink:0,children:Io}),qt[25]=Io,qt[26]=tn,qt[27]=Dn;else Dn=qt[27];const wn=!M&&fo;let en;if(qt[28]!==M||qt[29]!==P)en=M??$z(P),qt[28]=M,qt[29]=P,qt[30]=en;else en=qt[30];let No;if(qt[31]!==Ze)No=Ze&&e(n,{dimColor:!0,children:Ze}),qt[31]=Ze,qt[32]=No;else No=qt[32];let on;if(qt[33]!==Ge||qt[34]!==wn||qt[35]!==en||qt[36]!==No)on=r(n,{bold:Ge,dimColor:wn,wrap:"truncate",children:[en,No]}),qt[33]=Ge,qt[34]=wn,qt[35]=en,qt[36]=No,qt[37]=on;else on=qt[37];let Ho;if(qt[38]!==Po||qt[39]!==on)Ho=e(s,{width:Po,flexShrink:0,children:on}),qt[38]=Po,qt[39]=on,qt[40]=Ho;else Ho=qt[40];let Mo;if(qt[41]!==fo||qt[42]!==eo||qt[43]!==Ge)Mo=e(s,{flexGrow:1,width:0,paddingLeft:2,children:e(n,{dimColor:fo,bold:Ge,wrap:"truncate",children:eo})}),qt[41]=fo,qt[42]=eo,qt[43]=Ge,qt[44]=Mo;else Mo=qt[44];let qn;if(qt[45]!==Dt||qt[46]!==Ut)qn=[Dt,Ut].filter(Boolean),qt[45]=Dt,qt[46]=Ut,qt[47]=qn;else qn=qt[47];const fn=qn.join(" \\xB7 ");let Mn;if(qt[48]!==Dt||qt[49]!==Ft||qt[50]!==jt||qt[51]!==Ut)Mn=Ft>0&&r(n,{color:"warning",children:[Dt||Ut?" \\xB7 ":"",jt]}),qt[48]=Dt,qt[49]=Ft,qt[50]=jt,qt[51]=Ut,qt[52]=Mn;else Mn=qt[52];let go;if(qt[53]!==Dt||qt[54]!==H||qt[55]!==Ft||qt[56]!==Ut)go=H&&r(ne,{children:[Dt||Ut||Ft>0?" \\xB7 ":"",e(ln,{url:H.url,children:H.label})]}),qt[53]=Dt,qt[54]=H,qt[55]=Ft,qt[56]=Ut,qt[57]=go;else go=qt[57];let _n;if(qt[58]!==fo||qt[59]!==Ge||qt[60]!==fn||qt[61]!==Mn||qt[62]!==go)_n=r(n,{dimColor:fo,bold:Ge,children:[fn,Mn,go]}),qt[58]=fo,qt[59]=Ge,qt[60]=fn,qt[61]=Mn,qt[62]=go,qt[63]=_n;else _n=qt[63];let er;if(qt[64]!==xe||qt[65]!==_n)er=e(s,{minWidth:xe,flexShrink:0,marginLeft:1,justifyContent:"flex-end",children:_n}),qt[64]=xe,qt[65]=_n,qt[66]=er;else er=qt[66];let Tn;if(qt[67]!==Mt||qt[68]!==Dn||qt[69]!==Ho||qt[70]!==Mo||qt[71]!==er)Tn=r(s,{onClick:Mt,onMouseEnter:Fo,onMouseLeave:Eo,children:[Dn,Ho,Mo,er]}),qt[67]=Mt,qt[68]=Dn,qt[69]=Ho,qt[70]=Mo,qt[71]=er,qt[72]=Tn;else Tn=qt[72];return Tn}';

const panelChunk =
  'function Xao(rt,bt){return e(n,{dimColor:!0,wrap:"truncate",children:e(hi,{children:rt})},bt)}' +
  'function Aue(h){return e(n,{children:h.count+" idle agents"})}' +
  'function EGt(){return Date.now()}' +
  // The panel's clock state: its setter is what the 1 s interval calls, and
  // what the helper calls to re-render after a run. `yo` is a fresh array each
  // render, as 2.1.323's task-list builder returns.
  'function zPanel(h){h.onRender?.();let{columns:Dt}=Ae(),[er,Tn]=y(EGt),Jn=()=>Tn(Date.now()),yo=h.tasks.filter(Boolean),Ts=h.names,aa=yo.map(()=>void 0),wi=10,Td=5;if(aa.some(Boolean)&&tk()+wi+3+Td>Dt-SN)aa=aa;let jr=0,Ji=yo.length;let Ml=yo.slice(jr,Ji).map((Xi,Al)=>{let la=jr+Al;if(Dc(Xi)){return e(Aue,{count:Xi.taskIds.length},Xi.id)}let Vs=Xi;let md=aa[la];return e(xue,{task:Vs,name:Ts.get(Vs.id),link:md,isSelected:!1,isViewed:!1,treeConnector:void 0,descendantSuffix:void 0,labelWidth:wi,statusWidth:Td,statusParts:{elapsed:"3s",tokenText:"",queuedText:"",queuedCount:0},onClick:()=>{}},Vs.id)});return r(s,{flexDirection:"column",children:Ml})}' +
  rowComponent;

const fixture323 = runnerChunk + BUN_MODULE_BOUNDARY + panelChunk;
// 2.1.322: the feature still lives upstream.
const fixture322 = fixture323 + BUN_MODULE_BOUNDARY + "var appState={taskDecorations:{}};";
// Before the feature existed: no schema key.
const fixturePreFeature = fixture323.replace("var settingsSchema={subagentStatusLine:()=>({})};", "var settingsSchema={};");

function patched(source = fixture323) {
  const result = patchSubagentStatusLine(source);
  assert.equal(result.patched, 4, "fixture should patch");
  return result.content;
}

// ---------------------------------------------------------------------------
// Runner harness.
// ---------------------------------------------------------------------------
function runnerSource(content) {
  return content.split(BUN_MODULE_BOUNDARY)[0];
}

const SESSION = { id: "sess-1", host: "local", name: "demo" };
const SUBAGENT = { type: "command", command: "coralline/statusline.sh --subagent" };
const TASK = {
  id: "agent-1",
  type: "local_agent",
  status: "running",
  description: "Explore the repo",
  startTime: 1000,
  agentType: "Explore",
  model: "claude-opus-5-5[1m]",
  effort: "high",
  cwd: "/proj/sub",
  progress: { tokenCount: 4321, summary: "Reading files" },
};

function harness(content, { flags = {}, settings = {}, policy, execResult, timers } = {}) {
  let now = 10_000;
  const scheduled = [];
  const context = {
    Date: { now: () => now },
    setTimeout: timers ? (fn, ms) => (scheduled.push({ fn, ms }), { unref() {} }) : setTimeout,
    clearTimeout: timers ? () => {} : clearTimeout,
    AbortController,
    console,
  };
  vm.createContext(context);
  vm.runInContext(runnerSource(content), context);
  Object.assign(vm.runInContext("FLAGS", context), flags);
  vm.runInContext("SETTINGS", context).statusLine = { type: "command", command: "main-bar" };
  Object.assign(vm.runInContext("SETTINGS", context), settings);
  if (policy !== undefined) context.__policy = policy, vm.runInContext("POLICY=__policy", context);
  if (execResult) context.__exec = execResult, vm.runInContext("EXEC_RESULT=__exec", context);
  const run = (code) => vm.runInContext(code, context);
  return {
    context,
    run,
    scheduled,
    advance(ms) {
      now += ms;
    },
    get execs() {
      return run("EXECS");
    },
    get logs() {
      return run("LOGS");
    },
    // One main status-line run: records (session, payload) when its gates pass.
    async mainRun(session = SESSION) {
      context.__session = session;
      context.__payload = run(`Qcs({session:__session,mainLoopModel:"claude-opus-5-5",cwd:"/proj"})`);
      await run("aho(__session,__payload,new AbortController().signal)");
    },
    // One tick of the panel's call (the whole list, the panel's idle-group
    // test, columns, name map, clock setter): returns the decoration map.
    tick(tasks = [TASK], columns = 80, names = new Map([[TASK.id, "explorer"]]), refresh = undefined) {
      const tick = context.__calicoSubagentStatusLine;
      return tick ? tick(tasks, isGroup, columns, names, refresh) : undefined;
    },
    // Fires the newest pending debounce timer (timers: true), dropping the rest.
    fireDebounce() {
      const pending = scheduled.filter((entry) => entry.ms < 5000 && !entry.fired);
      for (const entry of pending) entry.fired = true;
      pending.at(-1)?.fn();
      return pending.length;
    },
    pendingDebounce() {
      return scheduled.filter((entry) => entry.ms < 5000 && !entry.fired).length;
    },
  };
}

// The panel's idle-group test (2.1.323 `Dc`, here by shape).
const isGroup = (item) => Array.isArray(item.taskIds);

// Values built inside the vm carry its realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const flush = () => new Promise((resolve) => setImmediate(resolve));

// The main status line's own executor calls are recorded too; these are the
// subagent ones.
function subagentExecs(h) {
  return h.execs.filter((call) => call.cfg.command !== "main-bar");
}

async function scenario(content, options = {}) {
  const h = harness(content, options);
  await h.mainRun();
  h.tick();
  await flush();
  return h;
}

// ---------------------------------------------------------------------------
// Applicability and verifier.
// ---------------------------------------------------------------------------
test("2.1.323 fixture: patched 4, verifier green", () => {
  const result = patchSubagentStatusLine(fixture323);
  assert.equal(result.patched, 4);
  assert.equal(result.skipped, undefined);
  assert.equal(evaluatePatchModule("subagent-statusline", result.content), null);
  assert.notEqual(evaluatePatchModule("subagent-statusline", fixture323), null, "unpatched 2.1.323 must fail the check");
});

test("2.1.322 and pre-feature fixtures report skipped and the verifier is green on them", () => {
  for (const [source, reason] of [
    [fixture322, /upstream implements/],
    [fixturePreFeature, /feature absent/],
  ]) {
    const result = patchSubagentStatusLine(source);
    assert.equal(result.skipped, true);
    assert.match(result.reason, reason);
    assert.equal(result.content, source);
    assert.equal(evaluatePatchModule("subagent-statusline", source), null);
  }
  // A not-applicable bundle that nonetheless carries the helper fails.
  assert.notEqual(evaluatePatchModule("subagent-statusline", patched() + "var appState={taskDecorations:{}};"), null);
});

// ---------------------------------------------------------------------------
// S1 anchors: each one removed patches nothing.
// ---------------------------------------------------------------------------
test("each S1 anchor removed: patched 0 and nothing injected", () => {
  const removals = {
    "disableAllHooks predicate": ["if(ng())return;let h=", "let h="],
    "statusLine-disabled gate": ['if(br("statusLine"))return;', ""],
    "workspace-trust guard": ['if(lq()){t("Skipping StatusLine command execution - workspace trust not accepted");return}', ""],
    "merged settings reader": ["kDt(Pr()?.statusLine)", "kDt(Pr().statusLine)"],
    "managed-only reader (kDt)": ['function kDt(e){return lnn()?ye("policySettings")?.statusLine:e}', "function kDt(e){return e}"],
    "executor call": ['X=await zz(J8e("statusLine")?QW({...y}):y,', "X=await zz(y,"],
    "per-host log binding shape": ["let h=Ius.of(e.host);", "let h=Ius.get(e.host);"],
  };
  for (const [label, [from, to]] of Object.entries(removals)) {
    assert.ok(fixture323.includes(from), `${label}: anchor present in fixture`);
    const source = fixture323.replace(from, () => to);
    const result = patchSubagentStatusLine(source);
    assert.equal(result.patched, 0, `${label}: patched 0`);
    assert.equal(result.content, source, `${label}: content untouched`);
    assert.ok(!result.content.includes("__calicoSL"), `${label}: no helper`);
  }
});

test("P3-4: a guard prefix holding anything but guards and the log binding patches nothing", () => {
  const source = fixture323.replace("let h=Ius.of(e.host);", () => "let h=Ius.of(e.host);sideEffect();");
  assert.equal(patchSubagentStatusLine(source).patched, 0);
  const assigning = fixture323.replace('if(br("statusLine"))return;', () => 'if(br(FLAGS.x=1))return;');
  assert.equal(patchSubagentStatusLine(assigning).patched, 0);
});

test("P3-1: executor arguments reading a name the helper does not bind patch nothing", () => {
  // `s` is the runner's verbose flag, `v` a runner local.
  for (const [from, to] of [
    ["n.cwd,r,hE(),H)", "n.cwd,r,hE(s),H)"],
    ["n.cwd,r,hE(),H)", "n.cwd,r,v,H)"],
    ["n.cwd,r,hE(),H)", "n.cwd,r,someGlobal,H)"],
  ]) {
    const source = fixture323.replace(from, () => to);
    assert.equal(patchSubagentStatusLine(source).patched, 0, to);
  }
});

test("row inserted before a later hook call is refused", () => {
  // A hook (useState) called after the pointer box would differ between the
  // decorated early return and the default path.
  const source = fixture323.replace("const wn=!M&&fo;", () => "const wn=!M&&fo;y(0);");
  assert.equal(patchSubagentStatusLine(source).patched, 0);
});

// ---------------------------------------------------------------------------
// Gate behaviour.
// ---------------------------------------------------------------------------
test("a 2.1.323-shaped task: the executor gets every field of the contract on stdin", async () => {
  const h = await scenario(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  const calls = subagentExecs(h);
  assert.equal(calls.length, 1);
  const call = calls[0];
  const stdin = JSON.parse(call.input);
  assert.equal(stdin.session_id, "sess-1");
  assert.equal(stdin.transcript_path, "/transcripts/sess-1.jsonl");
  assert.equal(stdin.cwd, "/proj");
  assert.deepEqual(stdin.model, { id: "claude-opus-5-5", display_name: "claude-opus-5-5" });
  assert.deepEqual(stdin.context_window, { context_window_size: 200000 });
  assert.equal(stdin.columns, 80);
  assert.deepEqual(stdin.tasks, [
    {
      id: "agent-1",
      name: "explorer",
      type: "local_agent",
      agentType: "Explore",
      status: "running",
      description: "Explore the repo",
      label: "Reading files",
      startTime: 1000,
      model: "claude-opus-5-5[1m]",
      effort: "high",
      contextWindowSize: 1000000,
      tokenCount: 4321,
      tokenSamples: [],
      cwd: "/proj/sub",
    },
  ]);
  // The rest of upstream's executor call is reused as is.
  assert.equal(call.event, "StatusLine");
  assert.equal(call.key, "statusLine");
  assert.equal(call.fifth, undefined);
  assert.deepEqual(plain(call.payloadArg), { fromPayload: "sess-1" });
  assert.deepEqual(plain(call.sessionArg), { project: "sess-1" });
  assert.equal(call.cwd, "/proj");
  assert.equal(call.hookId, "hook-id");
  assert.equal(call.hidden, undefined);
  assert.equal(call.cfg.command, SUBAGENT.command);
  // P3-3: the 5 s timeout the deprecated schema strips.
  assert.equal(call.cfg.timeout, 5);
  assert.equal(call.signal.aborted, false);
});

test("label falls back from a string label to progress.summary to description; cwd to the payload's", async () => {
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  await h.mainRun();
  h.tick([
    { id: "a", type: "local_agent", description: "D1", label: "L1" },
    { id: "b", type: "local_agent", description: "D2", progress: {} },
  ]);
  await flush();
  const tasks = JSON.parse(subagentExecs(h)[0].input).tasks;
  assert.deepEqual(tasks.map((task) => [task.label, task.cwd, task.contextWindowSize, task.tokenCount]), [
    ["L1", "/proj", undefined, 0],
    ["D2", "/proj", undefined, 0],
  ]);
});

for (const [label, flags, log] of [
  ["disableAllHooks", { hooksOff: true }, /guard ng\(\) holds/],
  ["statusLine-disabled gate", { statusLineOff: true }, /guard br\(\\?"statusLine\\?"\) holds/],
  ["untrusted workspace", { untrusted: true }, /workspace trust not accepted/],
]) {
  test(`${label}: nothing spawns and it logs once`, async () => {
    const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
    // Record while the gate is open, then close it: the tick must re-check.
    await h.mainRun();
    Object.assign(h.run("FLAGS"), flags);
    h.tick();
    await flush();
    h.advance(1000);
    h.tick();
    await flush();
    assert.equal(subagentExecs(h).length, 0);
    const matching = h.logs.filter((line) => line.startsWith("subagentStatusLine") && log.test(line));
    assert.equal(matching.length, 1, `logs: ${JSON.stringify(h.logs)}`);
  });
}

test("gates are re-evaluated on every tick: trust accepted mid-session starts spawning", async () => {
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  await h.mainRun();
  h.run("FLAGS").untrusted = true;
  h.tick();
  await flush();
  assert.equal(subagentExecs(h).length, 0);
  h.run("FLAGS").untrusted = false;
  h.advance(1000);
  h.tick();
  await flush();
  assert.equal(subagentExecs(h).length, 1);
});

test("P3-4: a guard upstream adds to the runner's prefix is inherited", async () => {
  const source = fixture323.replace("if(ng())return;let h=", () => "if(ng())return;if(newGuard())return;let h=");
  const content = patched(source.replace("function ng(){", () => "var NEW_GUARD=!1;function newGuard(){return NEW_GUARD}function ng(){"));
  const h = harness(content, { settings: { subagentStatusLine: SUBAGENT } });
  await h.mainRun();
  h.run("NEW_GUARD=!0");
  h.tick();
  await flush();
  assert.equal(subagentExecs(h).length, 0);
  assert.ok(h.logs.some((line) => line.includes("guard newGuard() holds")));
});

test("P3-2: nothing spawns before a main status-line run has recorded a payload", async () => {
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  // Published when the runner chunk loads, before any record.
  assert.equal(h.tick().size, 0);
  await flush();
  // Gates closed on the main run: no record either.
  h.run("FLAGS").untrusted = true;
  await h.mainRun();
  h.advance(1000);
  assert.equal(h.tick().size, 0);
  await flush();
  assert.equal(subagentExecs(h).length, 0);
});

test("subagentStatusLine without a recorded statusLine run logs once that it needs a statusLine command", async () => {
  const needs = (h) => h.logs.filter((line) => line.includes("nothing runs until a statusLine command is configured"));
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  for (let tick = 0; tick < 3; tick += 1) {
    h.tick();
    await flush();
    h.advance(1000);
  }
  assert.equal(subagentExecs(h).length, 0);
  assert.equal(needs(h).length, 1, JSON.stringify(h.logs));
  assert.match(needs(h)[0], /2\.1\.323\+/);
  // Nobody asked for subagentStatusLine: nothing to say.
  const quiet = harness(patched());
  quiet.tick();
  await flush();
  assert.equal(needs(quiet).length, 0);
  // Once the main status line has run, the command runs and nothing more is logged.
  await h.mainRun();
  h.tick();
  await flush();
  assert.equal(subagentExecs(h).length, 1);
  assert.equal(needs(h).length, 1);
});

test("captured binding not a function at call time: nothing spawns", async () => {
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  await h.mainRun();
  h.run("zRe=void 0");
  h.tick();
  await flush();
  assert.equal(subagentExecs(h).length, 0);
  assert.ok(h.logs.some((line) => line.includes("binding it runs through is not a function")));
});

for (const [label, flags] of [
  ["allowManagedHooksOnly", { allowManagedHooksOnly: true }],
  ["user disableAllHooks", { userDisableAllHooks: true }],
  ["safe mode", { safeMode: true }],
]) {
  test(`P2-1 ${label}: a project subagentStatusLine does not run; a policy one does, org-tagged`, async () => {
    const project = await scenario(patched(), { flags, settings: { subagentStatusLine: SUBAGENT } });
    assert.equal(subagentExecs(project).length, 0);

    const policyCommand = { type: "command", command: "managed-bar --subagent" };
    const managed = await scenario(patched(), {
      flags,
      settings: { subagentStatusLine: SUBAGENT },
      policy: { statusLine: { type: "command", command: "main-bar" }, subagentStatusLine: policyCommand },
    });
    const calls = subagentExecs(managed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cfg.command, "managed-bar --subagent");
    // P2-2: tagged as organization-origin because policy defines this key.
    assert.equal(calls[0].tagged, true);
  });
}

test("P2-2: a user/project command is not tagged as organization-origin, even when policy sets statusLine", async () => {
  const h = await scenario(patched(), {
    settings: { subagentStatusLine: SUBAGENT },
    policy: { statusLine: { type: "command", command: "main-bar" } },
  });
  const calls = subagentExecs(h);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tagged, false);
});

test("P3-1: a remote/bridged session hides the command text in the executor call and the helper's logs", async () => {
  const h = harness(patched(), {
    settings: { subagentStatusLine: SUBAGENT },
    execResult: () => ({ status: 3, stdout: "", stderr: "", aborted: false }),
  });
  await h.mainRun({ ...SESSION, remote: true });
  h.tick();
  await flush();
  const calls = subagentExecs(h);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hidden, "redacted");
  assert.ok(h.logs.some((line) => line === "subagentStatusLine [command left out] exited 3"), JSON.stringify(h.logs));
  assert.ok(!h.logs.some((line) => line.includes(SUBAGENT.command)));
});

test("P3-3: the helper aborts its own signal after 5 s", async () => {
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT }, timers: true });
  await h.mainRun();
  h.tick();
  await flush();
  const call = subagentExecs(h)[0];
  const timer = h.scheduled.find((entry) => entry.ms === 5000);
  assert.ok(timer, "a 5 s timer is armed");
  assert.equal(call.signal.aborted, false);
  timer.fn();
  assert.equal(call.signal.aborted, true);
});

test("P4: commands referencing plugin variables are refused in every spelling", async () => {
  for (const command of ["${CLAUDE_PLUGIN_ROOT}/s.sh", "$CLAUDE_PLUGIN_DATA/s.sh", "%CLAUDE_PLUGIN_ROOT%\\s.cmd"]) {
    const h = await scenario(patched(), { settings: { subagentStatusLine: { type: "command", command } } });
    assert.equal(subagentExecs(h).length, 0, command);
  }
});

test("non-command or missing subagentStatusLine spawns nothing", async () => {
  for (const settings of [{}, { subagentStatusLine: { type: "prompt", command: "x" } }, { subagentStatusLine: { type: "command" } }]) {
    const h = await scenario(patched(), { settings });
    assert.equal(subagentExecs(h).length, 0);
  }
});

test("output: one {id,content} per line, invalid lines dropped, map pruned to panel ids, debounced", async () => {
  const h = harness(patched(), {
    settings: { subagentStatusLine: SUBAGENT },
    execResult: () => ({
      status: 0,
      stderr: "",
      aborted: false,
      stdout: ['{"id":"agent-1","content":"\\u001b[32mROW\\u001b[0m"}', "not json", '{"id":"gone","content":"x"}', '{"id":"agent-1"}', ""].join("\n"),
    }),
  });
  await h.mainRun();
  h.tick();
  await flush();
  const map = h.tick();
  assert.deepEqual(plain([...map.entries()]), [["agent-1", { content: "\u001b[32mROW\u001b[0m" }]]);
  assert.equal(subagentExecs(h).length, 1, "debounced within 300 ms");
  h.advance(300);
  h.tick();
  await flush();
  assert.equal(subagentExecs(h).length, 2);
  // The agent left the panel: its decoration goes with it.
  assert.equal(h.tick([]).size, 0);
});

test("per-render cache: repeat calls with the same list and columns return the map without filtering or pruning", async () => {
  const h = harness(patched(), {
    settings: { subagentStatusLine: SUBAGENT },
    execResult: () => ({ status: 0, stderr: "", aborted: false, stdout: '{"id":"agent-1","content":"ROW"}' }),
  });
  await h.mainRun();
  const tick = h.context.__calicoSubagentStatusLine;
  let filtered = 0;
  const counting = (item) => (filtered++, isGroup(item));
  const list = [TASK, { id: "agent-2", type: "local_agent" }];
  const first = tick(list, counting, 80, new Map());
  assert.equal(filtered, 2);
  await flush();
  const map = tick(list, counting, 80, new Map());
  // A run landed in between: the cached call returns the current map, still
  // without touching the list.
  assert.equal(filtered, 2, "the same list reference is not filtered again");
  assert.equal(map.get("agent-1").content, "ROW");
  for (let row = 0; row < 5; row += 1) assert.equal(tick(list, counting, 80, new Map()), map);
  assert.equal(filtered, 2);
  assert.equal(subagentExecs(h).length, 1, "repeat calls start no run");
  // A new list (the next render) or new columns is filtered and pruned again.
  tick([TASK], counting, 80, new Map());
  assert.equal(filtered, 3);
  tick([TASK], counting, 81, new Map());
  assert.equal(filtered, 4);
  assert.notEqual(first, undefined);
});

// ---------------------------------------------------------------------------
// Mutation controls: the gate tests above fail when their gate is removed from
// the patched helper. Each control removes one gate and shows the same
// scenario now spawns.
// ---------------------------------------------------------------------------
test("controls: removing a gate from the patched helper lets the blocked scenario spawn", async () => {
  const content = patched();
  const controls = [
    ["disableAllHooks guard", /if\(ng\(\)\)\{__calicoLog\([^}]*\}/, { flags: { hooksOff: true } }, true],
    ["statusLine-disabled guard", /if\(br\("statusLine"\)\)\{__calicoLog\([^}]*\}/, { flags: { statusLineOff: true } }, true],
    ["trust guard", /if\(lq\(\)\)\{__calicoLog\([^}]*\}/, { flags: { untrusted: true } }, true],
    ["managed-only source", /lnn\(\)\?ye\("policySettings"\)\?\.subagentStatusLine:/, { flags: { allowManagedHooksOnly: true } }, false],
    ["plugin-variable refusal", /if\(__calicoRaw\.command\.includes\("CLAUDE_PLUGIN_ROOT"\)[^;]*;/, { settings: { subagentStatusLine: { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/s" } } }, false],
  ];
  for (const [label, gate, options, closeAfterRecord] of controls) {
    assert.match(content, gate, `${label}: gate present`);
    const mutated = content.replace(gate, "");
    const h = harness(mutated, { settings: { subagentStatusLine: SUBAGENT, ...(options.settings ?? {}) } });
    if (!closeAfterRecord) Object.assign(h.run("FLAGS"), options.flags ?? {});
    await h.mainRun();
    if (closeAfterRecord) Object.assign(h.run("FLAGS"), options.flags);
    h.tick();
    await flush();
    assert.equal(subagentExecs(h).length, 1, `${label}: removing it lets the command run`);
  }

  // The binding check.
  const unchecked = content.replace(/typeof zRe==="function"&&/, "");
  const h1 = harness(unchecked, { settings: { subagentStatusLine: SUBAGENT } });
  await h1.mainRun();
  h1.run("zRe=void 0");
  h1.tick();
  await flush();
  assert.ok(h1.logs.some((line) => line.includes("tick failed")), "without the check the executor call throws instead of refusing");

  // The org tag keyed on subagentStatusLine (P2-2): keyed on statusLine, a
  // project command would be tagged whenever policy sets statusLine.
  const statusKeyed = content.replace('J8e("subagentStatusLine")', 'J8e("statusLine")');
  const h2 = await scenario(statusKeyed, {
    settings: { subagentStatusLine: SUBAGENT },
    policy: { statusLine: { type: "command", command: "main-bar" } },
  });
  assert.equal(subagentExecs(h2)[0].tagged, true);

  // The no-payload-yet refusal (P3-2) and the 5 s timeout (P3-3).
  assert.match(content, /timeout:5\}/);
  assert.match(content, /if\(!__calicoRec\)return __calicoNoRecord\(\),null;/);
});

// ---------------------------------------------------------------------------
// Chunk aliasing: the helper must use the runner chunk's own names.
// ---------------------------------------------------------------------------
function renameToken(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`(?<![A-Za-z0-9_$.])${escaped}(?![A-Za-z0-9_$])`, "g"), () => to);
}

test("runner chunk aliases the context-window function and executor differently from the panel chunk", async () => {
  let runner = runnerChunk;
  for (const [from, to] of [
    ["R_", "$w$"],
    ["Im", "B$1"],
    ["zz", "Ex$"],
    ["J8e", "$$t"],
  ]) {
    runner = renameToken(runner, from, to);
  }
  // The panel chunk has its own, unrelated bindings under the old names.
  const panel = "function R_(){throw Error('panel R_')}function zz(){throw Error('panel zz')}" + panelChunk;
  const content = patched(runner + BUN_MODULE_BOUNDARY + panel);
  assert.ok(content.includes("Ex$($$t(\"subagentStatusLine\")?QW({...y}):y,\"StatusLine\""), "executor call re-emitted with the runner's names");
  assert.ok(content.includes("$w$(__calicoT.model,B$1())"));
  const h = await scenario(content, { settings: { subagentStatusLine: SUBAGENT } });
  const calls = subagentExecs(h);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].input).tasks[0].contextWindowSize, 1000000);
  assert.equal(calls[0].signal.aborted, false);
});

test("without a capturable context-window use site the field is omitted and the rest still patches", async () => {
  const source = fixture323.replace("context_window:bbt(rt,gt)", () => "context_window:null");
  const content = patched(source);
  const h = await scenario(content, { settings: { subagentStatusLine: SUBAGENT } });
  assert.equal(JSON.parse(subagentExecs(h)[0].input).tasks[0].contextWindowSize, undefined);
});

// ---------------------------------------------------------------------------
// Panel + row, mounted through React.
// ---------------------------------------------------------------------------
async function mountPanel(content, { tick, onRender } = {}) {
  const React = require("react");
  const { c } = require("react/compiler-runtime");
  const ink = await import("ink");
  const { PassThrough } = require("node:stream");
  const panelSource = content.split(BUN_MODULE_BOUNDARY)[1];
  const { jsx, jsxs } = require("react/jsx-runtime");
  const element = jsx;
  const context = {
    React,
    e: jsx,
    r: jsxs,
    s: ink.Box,
    n: ink.Text,
    ne: React.Fragment,
    ln: (props) => element(ink.Text, { children: props.children }),
    hi: (props) => element(ink.Text, { children: props.children }),
    E: c,
    y: React.useState,
    aM: (handler) => React.useCallback((event) => handler?.(event), [handler]),
    v: Symbol.for("react.memo_cache_sentinel"),
    se: { pointer: ">", circle: "o" },
    cs: "*",
    qr: (value) => value,
    _N: () => false,
    Kz: () => undefined,
    re: (value) => String(value).length,
    tk: () => 2,
    $z: (task) => task.description,
    Ae: () => ({ columns: 100 }),
    SN: 4,
    Dc: (item) => Array.isArray(item.taskIds),
    Math,
  };
  if (tick) context.__calicoSubagentStatusLine = tick;
  vm.createContext(context);
  vm.runInContext(panelSource, context);
  const out = new PassThrough();
  out.columns = 100;
  let frames = "";
  out.on("data", (chunk) => (frames += chunk));
  const errors = [];
  const props = (tasks) => ({ tasks, names: new Map([["agent-1", "explorer"]]), onRender });
  const app = ink.render(React.createElement(context.zPanel, props([TASK])), {
    stdout: out,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    context,
    rerender(tasks = [TASK]) {
      frames = "";
      app.rerender(React.createElement(context.zPanel, props(tasks)));
      return frames;
    },
    // Everything drawn since the last rerender() or take().
    take() {
      const drawn = frames;
      frames = "";
      return drawn;
    },
    unmount: () => app.unmount(),
    errors,
  };
}

test("row: decoration absent renders the default row; present renders the decorated row; hook order holds across both", async () => {
  const content = patched();
  const panel = await mountPanel(content);
  const ticks = [];
  let map = new Map();
  panel.context.__calicoSubagentStatusLine = (tasks, group, columns, names, refresh) => {
    ticks.push({ ids: tasks.filter((task) => !group(task)).map((task) => task.id), columns, name: names.get("agent-1"), refresh: typeof refresh });
    return map;
  };
  try {
    const plain = panel.rerender();
    assert.match(plain, /explorer/);
    assert.match(plain, /Reading files/);
    map = new Map([["agent-1", { content: "CORALLINE-ROW" }]]);
    const decorated = panel.rerender();
    assert.match(decorated, /CORALLINE-ROW/);
    assert.doesNotMatch(decorated, /Reading files/);
    map = new Map();
    const back = panel.rerender();
    assert.match(back, /Reading files/);
    assert.doesNotMatch(back, /CORALLINE-ROW/);
    // ink draws a render error (such as a hook-order change) into the frame.
    for (const frame of [plain, decorated, back]) assert.doesNotMatch(frame, /hooks|Error/);
  } finally {
    panel.unmount();
  }
  // The panel ticks with its task list and idle-group test, the width the row
  // text gets, the name map and its clock setter.
  assert.deepEqual(ticks.at(-1), { ids: ["agent-1"], columns: 100 - 2 - 4, name: "explorer", refresh: "function" });
});

test("an idle-agent group entry is not sent to the command", async () => {
  const h = harness(patched(), { settings: { subagentStatusLine: SUBAGENT } });
  await h.mainRun();
  h.tick([TASK, { id: "group", taskIds: ["x", "y"] }]);
  await flush();
  assert.deepEqual(JSON.parse(subagentExecs(h)[0].input).tasks.map((task) => task.id), ["agent-1"]);
});

// Finding: the tick used to hand back the previous run's map and nothing
// re-rendered when a run ended, so a row lagged one run, the first decoration
// waited for an unrelated render, and once no task ran (2.1.323 refreshes the
// panel every second only while one does) a finished agent's row could keep a
// stale "running" decoration. The helper now re-renders the panel through its
// clock setter once per changed map.
async function liveRow(content = patched()) {
  const h = harness(content, {
    settings: { subagentStatusLine: SUBAGENT },
    timers: true,
    execResult: (cfg, input) => ({
      status: 0,
      stderr: "",
      aborted: false,
      stdout: JSON.parse(input).tasks.map((task) => JSON.stringify({ id: task.id, content: `ROW-${task.status}` })).join("\n"),
    }),
  });
  await h.mainRun();
  let renders = 0;
  const panel = await mountPanel(content, { tick: h.context.__calicoSubagentStatusLine, onRender: () => (renders += 1) });
  return { h, panel, renders: () => renders };
}

test("re-render: the first completed run is drawn without an outside render, and an unchanged run draws nothing", async () => {
  const { h, panel, renders } = await liveRow();
  try {
    assert.equal(renders(), 1);
    assert.doesNotMatch(panel.take(), /ROW-/, "the mount render has no result yet");
    await flush();
    assert.equal(renders(), 2, "the finished run re-rendered the panel once");
    assert.match(panel.take(), /ROW-running/);
    // That render handed over a new list, so one more run follows; its output
    // is unchanged and it renders nothing, and nothing further is scheduled.
    h.advance(300);
    assert.equal(h.fireDebounce(), 1);
    await flush();
    assert.equal(subagentExecs(h).length, 2);
    assert.equal(renders(), 2, "an unchanged map does not re-render");
    assert.equal(h.pendingDebounce(), 0, "the loop has settled");
  } finally {
    panel.unmount();
  }
});

test("re-render: after the agent finishes, the changed final result is drawn with no further outside render", async () => {
  const { h, panel, renders } = await liveRow();
  try {
    await flush();
    h.advance(300);
    h.fireDebounce();
    await flush();
    panel.take();
    // The task-state change is the last render the panel gets on its own.
    panel.rerender([{ ...TASK, status: "completed" }]);
    const before = renders();
    h.advance(300);
    assert.equal(h.fireDebounce(), 1);
    await flush();
    assert.equal(renders(), before + 1);
    assert.match(panel.take(), /ROW-completed/);
    // The render that drew it schedules one more run; unchanged, it stops there.
    h.advance(300);
    h.fireDebounce();
    await flush();
    assert.equal(renders(), before + 1);
    assert.equal(h.pendingDebounce(), 0);
  } finally {
    panel.unmount();
  }
});

test("control: without the re-render call the first decoration needs an outside render", async () => {
  const content = patched();
  const call = 'if(typeof __calicoRefresh==="function")__calicoRefresh(Date.now())';
  assert.ok(content.includes(call));
  const { panel, renders } = await liveRow(content.replace(call, () => ""));
  try {
    await flush();
    assert.equal(renders(), 1);
    assert.doesNotMatch(panel.take(), /ROW-/);
  } finally {
    panel.unmount();
  }
});

test("the re-render anchor missing patches nothing", () => {
  for (const [from, to] of [
    ["[er,Tn]=y(EGt)", "er=Date.now()"],
    ["function EGt(){return Date.now()}", "function EGt(){return 0}"],
    ["Jn=()=>Tn(Date.now()),", ""],
  ]) {
    assert.ok(fixture323.includes(from), from);
    const source = fixture323.replace(from, () => to);
    const result = patchSubagentStatusLine(source);
    assert.equal(result.patched, 0, from);
    assert.equal(result.content, source);
  }
});

test("row: unpatched panel renders the same default row (no tick, no decoration)", async () => {
  const panel = await mountPanel(fixture323);
  try {
    const frame = panel.rerender();
    assert.match(frame, /explorer/);
    assert.match(frame, /Reading files/);
  } finally {
    panel.unmount();
  }
});

test("control: the same React harness catches a decorated return placed before a hook", async () => {
  // Move the early return above the row's last hook (the onClick wrapper) by
  // hand; React must reject the hook-count change, which shows the hook-order
  // test above can fail. (A return above every hook is not detectable this
  // way: React then treats the next render as a fresh mount and silently
  // drops the hover state, so the control keeps one hook ahead of it.)
  const bad = patched()
    .replace("[bt,Pt]=y(!1),Mt=aM(rt),", () => "[bt,Pt]=y(!1),")
    .replace(
      "{elapsed:Dt,tokenText:Ut,queuedText:jt,queuedCount:Ft}=Ie,to;",
      () => "{elapsed:Dt,tokenText:Ut,queuedText:jt,queuedCount:Ft}=Ie,to;if(__calicoDecoration?.content!==void 0)return e(n,{children:__calicoDecoration.content});let Mt=aM(rt);"
    );
  assert.ok(bad.includes("let Mt=aM(rt);"));
  const panel = await mountPanel(bad);
  let map = new Map();
  panel.context.__calicoSubagentStatusLine = () => map;
  const original = console.error;
  const reported = [];
  console.error = (...args) => reported.push(args.map(String).join(" "));
  let thrown = null;
  let frame = "";
  try {
    panel.rerender();
    map = new Map([["agent-1", { content: "X" }]]);
    try {
      // ink draws a render error into the frame.
      frame = panel.rerender();
    } catch (error) {
      thrown = error;
    }
  } finally {
    console.error = original;
    try {
      panel.unmount();
    } catch {}
  }
  const messages = [frame, String(thrown?.message ?? ""), ...reported].join("\n");
  assert.match(messages, /fewer hooks/i);
});
