// Resolve the newest Claude Code version published to npm, across every
// dist-tag rather than just `latest`.
//
// Upstream does not always promote a release to `latest`. 2.1.280 was published
// 2026-09-22T15:44Z onto `next` while `latest` still read 2.1.278 and `stable`
// read 2.1.267, so the release watcher — which read `dist-tags.latest` — could
// not see it at all. Reading every tag and taking the highest version picks a
// release up whichever tag it lands on first.
//
// Usage: npm view @anthropic-ai/claude-code dist-tags --json --silent \
//          | node scripts/newest-dist-tag-version.ts
// Prints "<tag> <version>" on success; exits 1 with a message on failure.

const PLAIN_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

// Only plain x.y.z values take part. The comparison is numeric per segment and
// has no rule for a prerelease suffix, so a `2.2.0-beta.1` would be ordered by
// guesswork. Dropping such a value falls back to the newest plain version
// instead of dispatching a build for a version this cannot order — the safe
// direction, and the one that keeps the old `latest` behaviour as the floor.
// Every version upstream has published so far is plain x.y.z (checked against
// `npm view @anthropic-ai/claude-code versions` on 2026-09-22).
function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function pickNewestDistTagVersion(distTags) {
  if (distTags === null || typeof distTags !== "object") {
    throw new Error("dist-tags payload is not an object");
  }

  const plain = Object.entries(distTags).filter(([, version]) =>
    typeof version === "string" && PLAIN_VERSION.test(version)
  );

  if (plain.length === 0) {
    throw new Error("no dist-tag carries a plain x.y.z version");
  }

  // Sorted rather than reduced so ties keep a defined winner. Object.entries
  // preserves insertion order and Array.prototype.sort is stable, and the last
  // element is taken, so when two tags point at the same version the one npm
  // listed *last* wins (measured 2026-09-22, and held by the tie case in
  // tests/newest-dist-tag-version.test.js). Only the tag name printed into the
  // run log differs; the version dispatched is the same either way.
  const sorted = [...plain].sort(([, a], [, b]) => compareVersions(a, b));
  const [tag, version] = sorted[sorted.length - 1];
  return { tag, version };
}

function main() {
  let raw;
  try {
    raw = require("node:fs").readFileSync(0, "utf8");
  } catch (error) {
    console.error(`could not read dist-tags from stdin: ${error.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`dist-tags payload is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  try {
    const { tag, version } = pickNewestDistTagVersion(parsed);
    console.log(`${tag} ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { pickNewestDistTagVersion, compareVersions };
