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
// runtime, which is how custom-context-window broke on upstream 2.1.242.
test("rejects an injected helper used outside the chunk that declares it", () => {
  const modules = jsModules("let a=__calico_display_window(1)", "function __calico_display_window(e){return e}");
  const joined = nativeBun.joinClaudeJsModules(modules);

  assert.throws(
    () => nativeBun.splitClaudeJsModules(joined, modules),
    /chunk-0\.js references injected identifier\(s\) it does not declare: __calico_display_window/
  );
});

test("accepts an injected helper declared in the chunk that uses it", () => {
  const modules = jsModules(
    "function __calicoLocal(e){return e}let a=__calicoLocal(1)",
    "let b=2"
  );

  assert.doesNotThrow(() =>
    nativeBun.splitClaudeJsModules(nativeBun.joinClaudeJsModules(modules), modules)
  );
});

test("accepts a cross-chunk helper reached through globalThis", () => {
  const modules = jsModules(
    "let a=globalThis.__calico_display_window(1)",
    "globalThis.__calico_display_window=function(e){return e};"
  );

  assert.doesNotThrow(() =>
    nativeBun.splitClaudeJsModules(nativeBun.joinClaudeJsModules(modules), modules)
  );
});

test("accepts var, let, const and class declarations of injected helpers", () => {
  for (const declaration of [
    "var __calicoX=1;let a=__calicoX",
    "let __calicoX=1;let a=__calicoX",
    "const __calicoX=1;let a=__calicoX",
    "class __calicoX{};let a=new __calicoX",
  ]) {
    const modules = jsModules(declaration, "let b=2");
    assert.doesNotThrow(
      () => nativeBun.splitClaudeJsModules(nativeBun.joinClaudeJsModules(modules), modules),
      declaration
    );
  }
});
