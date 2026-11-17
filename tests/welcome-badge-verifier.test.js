// The welcome-badge check holds what is left over, not how many titles
// upstream ships: 2.1.327 merged the version row's truncate and wrap branches,
// taking the bold "Claude Code" titles from three to two.
const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluatePatchModule } = require("../scripts/verify-patched-binary.ts");

const check = (content) => evaluatePatchModule("welcome-badge", content);
// The two titles as 2.1.327 ships them, reduced.
const v327 = 'o(n,{wrap:R?"truncate":"wrap",children:[e(n,{bold:!0,children:"Claude Code"})," "]});gt=e(n,{bold:!0,children:"Claude Code"});c=r(n,{color:"claude",children:["Welcome to Claude Code"," "]});';
const patched = v327.replaceAll('children:"Claude Code"', 'children:"Calico Claude"').replace("Welcome to Claude Code", "Welcome to Calico Claude");

test("two rewritten titles pass", () => {
  assert.equal(check(patched), null);
});

test("a title left unrewritten fails", () => {
  const half = patched.replace('children:"Calico Claude"', 'children:"Claude Code"');
  assert.match(check(half), /1 residual bold "Claude Code" title/);
  assert.match(check(patched.replace('{bold:!0,children:"Calico Claude"}', '{bold:!0},"Claude Code"')), /residual bold/);
});

test("the unpatched bundle fails on titles and the welcome line", () => {
  const problems = check(v327);
  assert.match(problems, /no "Calico Claude" branding/);
  assert.match(problems, /2 residual bold/);
  assert.match(problems, /residual "Welcome to Claude Code"/);
});
