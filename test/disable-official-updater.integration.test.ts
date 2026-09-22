// The disable-official-updater module rewrites three functions inside one Bun
// module: the updater-disabled predicate P, the plugin auto-update gate G, and
// the reason formatter R. tests/disable-official-updater.test.js holds the
// behaviour against a fixture, including the unpatched control and an
// early-return variant; this runs the same checks against the functions lifted
// out of the binary under test, which is the only place a rewrite landing on
// the wrong function would show up. Gated on CLAUDE_NATIVE_BINARY like the
// other integration tests.
import { expect, test } from "bun:test";
import vm from "node:vm";

const { readNativeContent } = require("../scripts/native-content.ts");

const binaryInput = process.env.CLAUDE_NATIVE_BINARY;
const shippedTest = binaryInput ? test : test.skip;

const BOUNDARY = "\n/*@@calico-bun-module-boundary@@*/\n";
const ID = "[A-Za-z_$][\\w$]*";

function braceBlock(text: string, from: number): string {
  const open = text.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  throw new Error("unbalanced function body");
}

function liftUpdaterModule(bundle: string) {
  const start = new RegExp(
    `function (${ID})\\(\\)\\{if\\((${ID})\\.DISABLE_UPDATES\\)return\\{type:"env",envVar:"DISABLE_UPDATES"\\}`
  ).exec(bundle);
  if (!start) throw new Error("updater-disabled predicate not found");
  const P = braceBlock(bundle, start.index);
  const moduleFrom = Math.max(0, bundle.lastIndexOf(BOUNDARY, start.index));
  const moduleTo = bundle.indexOf(BOUNDARY, start.index);
  const mod = bundle.slice(moduleFrom, moduleTo === -1 ? bundle.length : moduleTo);

  const names = {
    P: start[1],
    env: start[2],
    parse: new RegExp(`if\\((${ID})\\(process\\.env\\.DISABLE_AUTOUPDATER\\)\\)`).exec(P)![1],
    extra: new RegExp(`let ${ID}=(${ID})\\(\\);if\\(${ID}\\)return\\{type:"env",envVar:`).exec(P)![1],
    config: new RegExp(`let ${ID}=(${ID})\\(\\);if\\(${ID}\\.autoUpdates===`).exec(P)![1],
  };
  const W = new RegExp(`function (${ID})\\(\\)\\{return ${names.P.replace(/\$/g, "\\$")}\\(\\)!==null\\}`).exec(mod)!;
  const G = new RegExp(`function (${ID})\\(\\)\\{[^{}]*FORCE_AUTOUPDATE_PLUGINS\\}`).exec(mod)!;
  const Rstart = new RegExp(`function (${ID})\\(${ID}\\)\\{switch\\(${ID}\\.type\\)\\{`).exec(mod)!;
  return {
    source: [P, W[0], G[0], braceBlock(mod, Rstart.index)].join("\n"),
    names: { ...names, W: W[1], G: G[1], R: Rstart[1] },
  };
}

function run(lifted: ReturnType<typeof liftUpdaterModule>, env: Record<string, string> = {}) {
  const n = lifted.names;
  const sandbox: Record<string, unknown> = {
    process: { env },
    [n.env]: env,
    [n.parse]: (v: unknown) => ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase()),
    [n.extra]: () => null,
    [n.config]: () => ({ autoUpdates: undefined, installMethod: "native" }),
    out: {} as Record<string, unknown>,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${lifted.source}\nout.reason=${n.P}();out.updaterDisabled=${n.W}();` +
      `out.pluginsDisabled=${n.G}();out.text=out.reason?${n.R}(out.reason):null;`,
    sandbox
  );
  return sandbox.out as {
    reason: { type: string; envVar?: string } | null;
    updaterDisabled: boolean;
    pluginsDisabled: boolean;
    text: string | null;
  };
}

shippedTest("the shipped build never runs Anthropic's updater and keeps plugin auto-update", async () => {
  const handle = await readNativeContent(binaryInput as string);
  const lifted = liftUpdaterModule(handle.content);

  const plain = run(lifted);
  expect(plain.reason?.type).toBe("calico");
  expect(plain.updaterDisabled).toBe(true);
  expect(plain.pluginsDisabled).toBe(false);
  expect(plain.text).toBe("Calico build; updated by the Calico updater");

  // A user's own setting still takes precedence, with upstream's plugin
  // semantics: DISABLE_AUTOUPDATER disables plugin updates unless forced.
  const userSet = run(lifted, { DISABLE_AUTOUPDATER: "1" });
  expect(userSet.reason).toEqual({ type: "env", envVar: "DISABLE_AUTOUPDATER" });
  expect(userSet.pluginsDisabled).toBe(true);
  expect(run(lifted, { DISABLE_AUTOUPDATER: "1", FORCE_AUTOUPDATE_PLUGINS: "1" }).pluginsDisabled).toBe(false);
});
