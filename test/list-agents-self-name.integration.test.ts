// The self-name-in-user-listing module exists for one condition that cannot be
// produced on a build machine: a session whose Remote Control bridge may be
// live, which makes `/list-agents` withhold every name and directory not chosen
// by a human. `omitDirectories` comes from
// `mo(session) = IE(session) || kT.of(session).bridgeMayBeLive()`, and
// `bridgeMayBeLive` is wired to the interactive transport
// (`remoteBridgeLive = () => current !== null`), so no flag or environment
// variable reaches it -- `CLAUDE_CODE_ENVIRONMENT_KIND=bridge` was measured not
// to, because `IE` additionally requires `transportPersists !== false`.
//
// So this lifts the real formatForUser out of the binary under test and calls
// it with that condition set directly. The unit test in
// tests/self-name-in-user-listing.test.js holds the same behaviour against a
// fixture, including the unpatched control; this one holds it against the bytes
// that actually ship, which is the only place a mis-anchored replacement would
// show up.
import { expect, test } from "bun:test";
import vm from "node:vm";

const { readNativeContent } = require("../scripts/native-content.ts");

const binaryInput = process.env.CLAUDE_NATIVE_BINARY;
const shippedTest = binaryInput ? test : test.skip;

// Pull the listing renderer out of the bundle by the branch it guards, then
// walk braces from the body -- the parameter list is destructured, so counting
// from the first `{` closes on the parameter object instead of the body.
function extractRenderer(bundle: string): { source: string; name: string } {
  const anchor = bundle.indexOf(".self.callerIsSubagent?");
  if (anchor === -1) {
    throw new Error("listing renderer not found in bundle");
  }
  const start = bundle.lastIndexOf("function ", anchor);

  let depth = 0;
  let cursor = bundle.indexOf("(", start);
  for (; cursor < bundle.length; cursor++) {
    if (bundle[cursor] === "(") depth++;
    else if (bundle[cursor] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }

  const bodyStart = bundle.indexOf("{", cursor);
  depth = 0;
  let end = -1;
  for (let i = bodyStart; i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("listing renderer body did not close");
  }

  const source = bundle.slice(start, end);
  return { source, name: source.slice("function ".length, source.indexOf("(")) };
}

shippedTest(
  "/list-agents keeps the self-name line when the connection withholds peer names",
  async () => {
    const handle = await readNativeContent(binaryInput as string);
    const { source, name } = extractRenderer(handle.content);

    // The renderer's free dependencies, all named in the same chunk. `Q` mirrors
    // the real peer section's withholding so the assertions can tell "self line
    // restored" apart from "the flag stopped working entirely".
    const sandbox: Record<string, unknown> = {
      F: () => [],
      M: () => [],
      Y: (subagents: unknown[]) => `Subagents(${subagents.length})`,
      J: (teammates: unknown[]) => `Teammates(${teammates.length})`,
      Q: (peers: any[], omitDirectories: boolean) =>
        "Other Claude sessions:\n" +
        peers
          .map(
            (peer) =>
              "  " +
              (omitDirectories && peer.session.nameSource !== "user"
                ? "(unnamed session)"
                : peer.session.name) +
              (omitDirectories ? "" : `  ·  ${peer.session.cwd}`)
          )
          .join("\n"),
      R: (self: any) => `${self.name} [ref]`,
      _: "(list truncated)",
      k: "(messaging disabled)",
      mf: "main",
      module: { exports: {} as unknown },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nmodule.exports=${name};`, sandbox);
    const formatForUser = (sandbox.module as { exports: Function }).exports;

    const peers = [
      {
        transport: "uds",
        session: { name: "peer-a", nameSource: "generated", cwd: "/secret/path" },
      },
    ];
    const extras = {
      appState: {},
      teamFile: null,
      callerTeammateId: undefined,
      self: {
        name: "calico-under-test",
        token: "calico-under-test [ref]",
        socketToken: "calico-under-test [ref]",
        sock: "sock",
        callerIsSubagent: false,
        // The session never ran /rename, which is what upstream's gate keys on.
        nameIsUserChosen: false,
      },
    };

    const rendered = formatForUser(peers, extras, { omitDirectories: true });

    // What the patch restores.
    expect(rendered).toContain("This session: calico-under-test [ref]");
    // What it must leave alone: the flag still hides other sessions.
    expect(rendered).toContain("(unnamed session)");
    expect(rendered).not.toContain("peer-a");
    expect(rendered).not.toContain("/secret/path");
    expect(rendered).toContain("withheld on this connection");
  }
);
