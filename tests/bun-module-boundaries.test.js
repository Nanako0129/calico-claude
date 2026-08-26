const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const nativeBun = require(path.join(__dirname, "..", "scripts", "native-bun.ts"));

function jsModules(...contents) {
  return contents.map((content, index) => ({
    index: index * 2 + 1,
    name: `/$bunfs/root/chunk-${index}.js`,
    content,
  }));
}

test("round-trips module contents through join and split", () => {
  const modules = jsModules("let a=1", "let b=2", "let c=3");
  const replacements = nativeBun.splitClaudeJsModules(
    nativeBun.joinClaudeJsModules(modules),
    modules
  );

  assert.deepEqual([...replacements.keys()], [1, 3, 5]);
  for (const module of modules) {
    assert.equal(replacements.get(module.index).toString("utf8"), module.content);
  }
});

test("keys replacements by container module index, not by position", () => {
  const modules = jsModules("let a=1", "let b=2");
  const replacements = nativeBun.splitClaudeJsModules(
    nativeBun.joinClaudeJsModules(modules),
    modules
  );

  assert.equal(replacements.get(3).toString("utf8"), "let b=2");
  assert.equal(replacements.get(0), undefined);
});

test("carries patched content back to the right module", () => {
  const modules = jsModules("let a=1", "let b=2");
  const patched = nativeBun.joinClaudeJsModules(modules).replace("let b=2", "let b=99");
  const replacements = nativeBun.splitClaudeJsModules(patched, modules);

  assert.equal(replacements.get(1).toString("utf8"), "let a=1");
  assert.equal(replacements.get(3).toString("utf8"), "let b=99");
});

test("rejects a patch that consumed a module boundary", () => {
  const modules = jsModules("let a=1", "let b=2", "let c=3");
  const joined = nativeBun.joinClaudeJsModules(modules);
  const collapsed = joined.replace("\n/*@@calico-bun-module-boundary@@*/\n", "");

  assert.throws(
    () => nativeBun.splitClaudeJsModules(collapsed, modules),
    /2 module section\(s\) but the binary has 3/
  );
});

test("rejects a patch that introduced an extra module boundary", () => {
  const modules = jsModules("let a=1", "let b=2");
  const joined = `${nativeBun.joinClaudeJsModules(modules)}\n/*@@calico-bun-module-boundary@@*/\nlet d=4`;

  assert.throws(() => nativeBun.splitClaudeJsModules(joined, modules), /3 module section\(s\)/);
});

test("refuses source that already contains the boundary marker", () => {
  const modules = jsModules("let a=1", "let b=2\n/*@@calico-bun-module-boundary@@*/\nlet c=3");

  assert.throws(() => nativeBun.joinClaudeJsModules(modules), /already present/);
});

// Bun chunks are separate ES module scopes. A helper declared in one chunk and
// called from another passes every text-level check and is undefined at
// runtime, which is how custom-context-window broke on upstream 2.1.242 and how
// thinking-streaming shipped a binary that died at startup with
// "__cc_streamingThinkingSelector is not defined".
//
// The scope check compares the patched text against the module's unpatched
// text, so these tests pass the clean modules as the originals and a separately
// built patched string, the way splitClaudeJsModules is actually called.
function splitPatched(originalContents, patchedContents) {
  const modules = jsModules(...originalContents);
  const patched = patchedContents.join("\n/*@@calico-bun-module-boundary@@*/\n");
  return () => nativeBun.splitClaudeJsModules(patched, modules);
}

test("rejects an injected helper used outside the chunk that declares it", () => {
  assert.throws(
    splitPatched(
      ["let a=1", "let b=2"],
      ["let a=__calico_display_window(1)", "function __calico_display_window(e){return e}let b=2"]
    ),
    /chunk-0\.js references injected identifier\(s\) it does not declare: __calico_display_window/
  );
});

test("rejects an injected helper passed as a value across chunks", () => {
  // The thinking-streaming failure: the selector is never called at the use
  // site, only handed to a hook, so a call-position-only check would miss it.
  assert.throws(
    splitPatched(
      ["let a=1", "let b=2"],
      [
        "let a=hook(store,__cc_streamingThinkingSelector)",
        "function __cc_streamingThinkingSelector(e){return e.streamingThinking}let b=2",
      ]
    ),
    /chunk-0\.js references injected identifier\(s\) it does not declare: __cc_streamingThinkingSelector/
  );
});

test("accepts an injected helper declared in the chunk that uses it", () => {
  assert.doesNotThrow(
    splitPatched(
      ["let a=1", "let b=2"],
      ["function __calicoLocal(e){return e}let a=__calicoLocal(1)", "let b=2"]
    )
  );
});

test("accepts a cross-chunk helper reached through globalThis", () => {
  assert.doesNotThrow(
    splitPatched(
      ["let a=1", "let b=2"],
      [
        "let a=globalThis.__calico_display_window(1)",
        "globalThis.__calico_display_window=function(e){return e};let b=2",
      ]
    )
  );
});

test("accepts var, let, const and class declarations of injected helpers", () => {
  for (const declaration of [
    "var __calicoX=1;let a=__calicoX",
    "let __calicoX=1;let a=__calicoX",
    "const __calicoX=1;let a=__calicoX",
    "class __calicoX{};let a=new __calicoX",
  ]) {
    assert.doesNotThrow(splitPatched(["let a=1", "let b=2"], [declaration, "let b=2"]), declaration);
  }
});

test("accepts arrow parameters and destructuring targets as bindings", () => {
  assert.doesNotThrow(
    splitPatched(
      ["let a=1", "let b=2"],
      [
        'let a=r.split("\n").map((__cc_line)=>"+"+__cc_line)',
        "let{streamingToolUses:x,streamingThinking:__cc_state}=hook(s);let b=__cc_state",
      ]
    )
  );
});

test("does not flag an upstream identifier that shares an injected prefix", () => {
  // Upstream generates a shell snippet using `$__cc_name`, `__cc_set` and
  // `read -r __cc_line`. Those are not bindings in the surrounding JavaScript
  // and are not ours, so a prefix-only check reports them forever.
  const upstream = 'let s=\'\\builtin eval "__cc_set=\\${$__cc_name+x}"; read -r __cc_line\';';
  assert.doesNotThrow(splitPatched([upstream, "let b=2"], [upstream, "let b=2"]));
});
