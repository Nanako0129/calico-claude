// The release watcher used to read `dist-tags.latest`, which made it blind to
// a release published onto another tag. That is not hypothetical: on
// 2026-09-22 upstream published 2.1.280 to `next` at 15:44Z while `latest`
// still read 2.1.278 and `stable` read 2.1.267, and the watch kept reporting
// 2.1.278 as newest.
//
// The failure that matters here is silent and in one direction: a resolver that
// picks the wrong entry still prints a plausible version, and the watch then
// builds the wrong release or none at all. So these assertions pin the
// ordering rather than the shape of the output.
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  pickNewestDistTagVersion,
  compareVersions,
} = require("../scripts/newest-dist-tag-version.ts");

// The exact payload npm returned while the bug was observable.
const OBSERVED_2026_09_22 = {
  stable: "2.1.267",
  latest: "2.1.278",
  next: "2.1.280",
};

test("picks the version on `next` when it is newer than `latest`", () => {
  assert.deepEqual(pickNewestDistTagVersion(OBSERVED_2026_09_22), {
    tag: "next",
    version: "2.1.280",
  });
});

test("the control: reading `latest` alone misses it", () => {
  // Not a test of the module — a record of what the old step returned on the
  // same payload, so the assertion above cannot quietly stop meaning anything.
  assert.equal(OBSERVED_2026_09_22.latest, "2.1.278");
  assert.notEqual(
    OBSERVED_2026_09_22.latest,
    pickNewestDistTagVersion(OBSERVED_2026_09_22).version
  );
});

test("keeps `latest` when no other tag is ahead of it", () => {
  assert.deepEqual(
    pickNewestDistTagVersion({
      stable: "2.1.267",
      latest: "2.1.278",
      next: "2.1.270",
    }),
    { tag: "latest", version: "2.1.278" }
  );
});

test("orders by numeric segment, not lexically", () => {
  // "2.1.9" sorts after "2.1.10" as a string, which is the classic way a
  // resolver like this ships a downgrade.
  assert.deepEqual(
    pickNewestDistTagVersion({ latest: "2.1.9", next: "2.1.10" }),
    { tag: "next", version: "2.1.10" }
  );
  assert.ok(compareVersions("2.1.10", "2.1.9") > 0);
  assert.ok(compareVersions("2.2.0", "2.10.0") < 0);
  assert.ok(compareVersions("3.0.0", "2.999.999") > 0);
  assert.equal(compareVersions("2.1.280", "2.1.280"), 0);
});

test("ignores a tag whose version it cannot order", () => {
  // A prerelease suffix has no rule in the numeric comparison, so it is dropped
  // rather than ranked by guesswork. Falling back to the newest plain version
  // keeps the old `latest` behaviour as the floor instead of dispatching a
  // build for a version whose position is unknown.
  assert.deepEqual(
    pickNewestDistTagVersion({
      latest: "2.1.278",
      next: "2.2.0-beta.1",
    }),
    { tag: "latest", version: "2.1.278" }
  );
});

test("ignores non-string tag values", () => {
  assert.deepEqual(
    pickNewestDistTagVersion({ latest: "2.1.278", broken: null }),
    { tag: "latest", version: "2.1.278" }
  );
});

test("a single tag still resolves", () => {
  assert.deepEqual(pickNewestDistTagVersion({ latest: "2.1.278" }), {
    tag: "latest",
    version: "2.1.278",
  });
});

test("ties resolve to the tag npm listed last", () => {
  // Only the tag name in the run log differs, but pinning it stops the tie
  // being resolved differently by a later refactor without anyone noticing.
  assert.deepEqual(
    pickNewestDistTagVersion({ latest: "2.1.280", next: "2.1.280" }),
    { tag: "next", version: "2.1.280" }
  );
  assert.deepEqual(
    pickNewestDistTagVersion({ next: "2.1.280", latest: "2.1.280" }),
    { tag: "latest", version: "2.1.280" }
  );
});

test("throws rather than returning a version when nothing is orderable", () => {
  // The watcher must fail loudly here. Returning an empty string would let the
  // step succeed and dispatch a build for no version at all.
  assert.throws(() => pickNewestDistTagVersion({}), /no dist-tag/);
  assert.throws(
    () => pickNewestDistTagVersion({ next: "2.2.0-beta.1" }),
    /no dist-tag/
  );
  assert.throws(() => pickNewestDistTagVersion(null), /not an object/);
  assert.throws(() => pickNewestDistTagVersion("2.1.280"), /not an object/);
});
