// thinking-folded draws a finished thinking block as one line — its first
// sentence and duration — and expands it on click. The fixture is a React
// chunk plus the renderer chunk from 2.1.285, reduced to what the module reads:
// the useState export, the `case"thinking":` call site (as thinking-inline
// leaves it, without the hidden-outside-transcript guard) and the thinking
// component's glyph box. The wrapper it injects is then rendered with stub JSX,
// so the assertions are on the element tree, not on the patched source text.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchThinkingFolded } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const BOUNDARY = "\n/*@@calico-bun-module-boundary@@*/\n";
const reactChunk =
  'var Rx={H:null};var g=function(t){return Rx.H.useState(t)},T=function(t,e){return Rx.H.useEffect(t,e)};\nexport{g,T};';
const rendererChunk =
  'import{g,T}from"/$bunfs/root/chunk-react.js";import{e,s,n}from"/$bunfs/root/chunk-ui.js";' +
  'function Ir(m){let{param:l}=m;return e(s,{children:[e(s,{minWidth:2,children:e(n,{"aria-label":"thinking:",dimColor:!0,italic:!0,children:"\\u2234"})}),e(n,{children:l.thinking})]})}' +
  'function render(l,h,E,R){switch(l.type){case"thinking":{return e(Ir,{addMargin:h,param:l,isTranscriptMode:E,verbose:R})}default:return null}}';
const fixture = reactChunk + BOUNDARY + rendererChunk;

// Runs the patched renderer chunk with stub JSX and a fixed useState value, and
// returns the tree the wrapper renders for `param`.
function draw(param, { open = false, transcript = false, ms } = {}) {
  const result = patchThinkingFolded(fixture);
  assert.equal(result.patched, 1);
  const renderer = result.content.split(BOUNDARY)[1].replace(/import\{[^}]*\}from"[^"]+";/g, "");
  const context = {
    e: (type, props) => ({ type, props }),
    s: "Box",
    n: "Text",
    g: () => [open, () => {}],
  };
  vm.createContext(context);
  vm.runInContext(renderer, context);
  context.__calicoThoughtMs = new WeakMap(ms === undefined ? [] : [[param, ms]]);
  const element = context.render(param, false, transcript, false);
  return { tree: element.type(element.props), Ir: context.Ir };
}

const folded = (tree) => tree.props.children.props.children;

test("folded: first sentence in italics, duration upright, clickable", () => {
  const { tree } = draw({ type: "thinking", thinking: "Check the version.  Then patch it." }, { ms: 5200 });
  assert.equal(typeof tree.props.onClick, "function");
  const [sentence, duration] = folded(tree);
  assert.equal(sentence.props.children, "∴ Check the version.");
  assert.equal(sentence.props.italic, true);
  assert.equal(duration, " · Thought for 5s");
});

test("folded: a version number's dots do not end the sentence", () => {
  const { tree } = draw({ type: "thinking", thinking: "Bundle 2.1.285 moved the anchor. Rebuild." }, { ms: 900 });
  assert.equal(folded(tree)[0].props.children, "∴ Bundle 2.1.285 moved the anchor.");
  assert.equal(folded(tree)[1], " · Thought for 1s");
});

test("folded: no recorded duration leaves the sentence alone", () => {
  const { tree } = draw({ type: "thinking", thinking: "Only one thought" });
  const [sentence, duration] = folded(tree);
  assert.equal(sentence.props.children, "∴ Only one thought");
  assert.equal(duration, "");
});

test("expanded: full component plus the duration, and a click folds it back", () => {
  const { tree, Ir } = draw({ type: "thinking", thinking: "Check the version. Then patch it." }, { open: true, ms: 65000 });
  assert.equal(typeof tree.props.onClick, "function");
  const [full, duration] = tree.props.children;
  assert.equal(full.type, Ir);
  assert.equal(duration.props.children.props.children, "Thought for 1m 5s");
});

test("transcript mode starts expanded", () => {
  const { tree, Ir } = draw({ type: "thinking", thinking: "Check the version." }, { transcript: true });
  assert.equal(tree.props.children[0].type, Ir);
  assert.equal(tree.props.onClick, undefined);
});

test("the verifier rejects the unpatched bundle and a fold without a recorded duration", () => {
  assert.match(evaluatePatchModule("thinking-folded", fixture), /wrapper/);
  assert.match(evaluatePatchModule("thinking-folded", patchThinkingFolded(fixture).content), /duration/);
});

test("without a resolvable useState the bundle is left untouched", () => {
  const noHook = fixture.replace("return Rx.H.useState(t)", "return Rx.H.useRef(t)");
  const result = patchThinkingFolded(noHook);
  assert.equal(result.patched, 0);
  assert.equal(result.content, noHook);
});
