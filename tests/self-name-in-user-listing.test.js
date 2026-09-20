// `/list-agents` renders through `formatForUser`, which prints a leading
// "This session: <name> [<ref>] (the name other sessions use to message it)"
// line and then drops it whenever the connection withholds names and
// directories not chosen by a human — which is every connection with a live
// Remote Control bridge (`mo(session) = IE(session) || kT.of(session).bridgeMayBeLive()`,
// measured in 2.1.278). Withholding other sessions' auto-generated names is the
// point of that flag; withholding your own leaves you unable to read the
// address peers must use for you.
//
// These assertions run the patched gate rather than grepping it. A text check
// cannot distinguish a gate that now admits the self line from one that
// admits it while reading a different object than the branch it guards, and it
// cannot tell that peers' names are still withheld.
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { patchSelfNameInUserListing } = require("../patch-claude-display.ts");
const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

// The shape measured in 2.1.276, 2.1.277 and 2.1.278 — identical on all three,
// including the local names. Nothing here matches on those names: the module
// captures them and emits them back, because a minified local is not syntax.
//
// Reduced to the clause under test plus enough of the surrounding renderer to
// prove the peer rows are untouched. `R` stands in for the token formatter and
// `Q` for the peer-row renderer that withholds names under omitDirectories.
const fixture = ({ selfLocal = "n", omitLocal = "m" } = {}) => `
function R(e){return \`\${e.name} [ref]\`}
function Q(e,n=!1){
  return "Other Claude sessions:\\n" + e.map((s)=>
    "  " + (n && s.nameSource!=="user" ? "(unnamed session)" : s.name)
  ).join("\\n");
}
function render(e,${selfLocal},{messagingDisabled:c=!1,omitDirectories:${omitLocal}=!1}={}){
  let i=[];
  if(e.length>0)i.push(Q(e,${omitLocal}));
  let f=c||!${selfLocal}.self||${omitLocal}&&!${selfLocal}.self.nameIsUserChosen?null:${selfLocal}.self.callerIsSubagent?\`This process's main session: \${R(${selfLocal}.self)}\`:\`This session: \${R(${selfLocal}.self)} (the name other sessions use to message it)\`;
  return f?\`\${f}\\n\\n\${i.join("\\n\\n")}\`:i.join("\\n\\n");
}
`;

const evaluate = (source) => {
  const context = { module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(`${source}\nmodule.exports={render};`, context);
  return context.module.exports.render;
};

// A session on a Remote Control connection whose name it did not choose: the
// exact combination the user hit.
const peers = [{ name: "peer-a", nameSource: "generated" }];
const extras = (nameIsUserChosen) => ({
  self: { name: "calico-claude-c5", nameIsUserChosen, callerIsSubagent: false },
});
const withheld = { omitDirectories: true };

test("unpatched control: the self line is withheld on an omitDirectories connection", () => {
  const render = evaluate(fixture());
  const out = render(peers, extras(false), withheld);
  // The control must be red for the right reason, or the patched assertion
  // below proves nothing about the patch.
  assert.ok(
    !out.includes("This session:"),
    "control should reproduce the reported bug (self line absent)"
  );
  assert.ok(out.includes("(unnamed session)"), "control should withhold peer names");
});

test("patched: the self line survives an omitDirectories connection", () => {
  const { content, candidates, patched } = patchSelfNameInUserListing(fixture());
  assert.equal(candidates, 1);
  assert.equal(patched, 1);

  const render = evaluate(content);
  const out = render(peers, extras(false), withheld);
  assert.ok(
    out.includes("This session: calico-claude-c5 [ref] (the name other sessions use to message it)"),
    `expected the self line, got: ${out}`
  );
  // The flag still does its actual job: the peer's generated name stays hidden.
  assert.ok(out.includes("(unnamed session)"), "peer names must still be withheld");
  assert.ok(!out.includes("peer-a"), "peer names must not leak");
});

test("patched: messagingDisabled still suppresses the self line", () => {
  const { content } = patchSelfNameInUserListing(fixture());
  const render = evaluate(content);
  const out = render(peers, extras(true), { messagingDisabled: true });
  assert.ok(
    !out.includes("This session:"),
    "the messagingDisabled half of the gate must survive"
  );
});

test("patched: a missing self descriptor still suppresses the self line", () => {
  const { content } = patchSelfNameInUserListing(fixture());
  const render = evaluate(content);
  const out = render(peers, { self: null }, withheld);
  assert.ok(!out.includes("This session:"), "the !self half of the gate must survive");
});

test("patched: the subagent wording is still reachable", () => {
  const { content } = patchSelfNameInUserListing(fixture());
  const render = evaluate(content);
  const out = render(peers, {
    self: { name: "main", nameIsUserChosen: false, callerIsSubagent: true },
  }, withheld);
  assert.ok(out.includes("This process's main session: main [ref]"), out);
});

test("the module does not pin the bundle's local names", () => {
  const renamed = fixture({ selfLocal: "$x", omitLocal: "_q$2" });
  const { candidates, patched, content } = patchSelfNameInUserListing(renamed);
  assert.equal(candidates, 1);
  assert.equal(patched, 1);
  const out = evaluate(content)(peers, extras(false), withheld);
  assert.ok(out.includes("This session: calico-claude-c5 [ref]"), out);
});

test("verifier accepts the patched shape and rejects the unpatched one", () => {
  const unpatched = fixture();
  assert.notEqual(
    evaluatePatchModule("self-name-in-user-listing", unpatched),
    null,
    "verifier must reject a bundle still carrying the omitDirectories clause"
  );

  const { content } = patchSelfNameInUserListing(unpatched);
  assert.equal(evaluatePatchModule("self-name-in-user-listing", content), null);
});

test("verifier rejects a gate that guards a different object than it tests", () => {
  // The failure a plain "is the clause gone" scan cannot see: the gate admits
  // the line based on one descriptor while the branch renders another.
  const crossed = patchSelfNameInUserListing(fixture()).content.replace(
    "!n.self?null:n.self.callerIsSubagent",
    "!n.self?null:other.self.callerIsSubagent"
  );
  assert.notEqual(evaluatePatchModule("self-name-in-user-listing", crossed), null);
});
