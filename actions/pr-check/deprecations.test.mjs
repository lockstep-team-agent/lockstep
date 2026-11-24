/** The retired-identifier matcher is pure — feed it a -U0 diff, assert the hits. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findRetiredUses, parseAddedLines, isSkippedPath, hitMessage } from "./deprecations.mjs";
import { buildComment } from "./comment.mjs";

const DEPS = [
  { decisionId: "d1aaaaaa-0000", retired: "axios", replacement: "lib/http.client" },
  { decisionId: "d2bbbbbb-0000", retired: "fetchWithRetry", replacement: "http.get" },
];

const DIFF = [
  "diff --git a/src/api.ts b/src/api.ts",
  "--- a/src/api.ts",
  "+++ b/src/api.ts",
  "@@ -3,0 +4,2 @@",
  "+import axios from 'axios';",
  "+const mock = axiosMock(); // not a hit: different identifier",
  "@@ -10 +12 @@",
  "-old line using axios // removed lines never count",
  "+await fetchWithRetry(url);",
  "+++ not a header: an added line that starts with ++",
  "diff --git a/node_modules/x/index.js b/node_modules/x/index.js",
  "--- /dev/null",
  "+++ b/node_modules/x/index.js",
  "@@ -0,0 +1 @@",
  "+require('axios')",
  "diff --git a/package-lock.json b/package-lock.json",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -0,0 +1 @@",
  '+"axios": "1.0.0"',
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-axios",
].join("\n");

test("parseAddedLines: only + lines, with new-file line numbers per hunk", () => {
  const added = parseAddedLines(DIFF).filter((a) => a.file === "src/api.ts");
  assert.deepEqual(
    added.map((a) => a.line),
    [4, 5, 12, 13],
  );
});

test("findRetiredUses: word-boundary hits on added lines; skips deps, lockfiles and removals", () => {
  const hits = findRetiredUses(DIFF, DEPS);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.retired}`),
    ["src/api.ts:4:axios", "src/api.ts:12:fetchWithRetry"],
  );
  assert.equal(hitMessage(hits[0]), "Uses retired axios — use lib/http.client (decision #d1aaaaaa)");
});

test("findRetiredUses: regex metacharacters in retired are literal", () => {
  const diff = "--- /dev/null\n+++ b/a.py\n@@ -0,0 +1,2 @@\n+from lib import old.client\n+oldXclient()";
  const hits = findRetiredUses(diff, [{ decisionId: "d3", retired: "old.client", replacement: "new.client" }]);
  assert.deepEqual(hits.map((h) => h.line), [1]);
});

test("findRetiredUses: no deprecations → no hits", () => {
  assert.deepEqual(findRetiredUses(DIFF, []), []);
  assert.deepEqual(findRetiredUses(DIFF, undefined), []);
});

test("isSkippedPath: vendored trees and lockfiles", () => {
  for (const p of ["node_modules/a.js", "web/node_modules/a.js", "vendor/x.go", "third_party/y.c", "yarn.lock", "go.sum", "a/Cargo.lock"])
    assert.ok(isSkippedPath(p), p);
  for (const p of ["src/vendors.ts", "lib/lockstep.ts", "package.json"]) assert.ok(!isSkippedPath(p), p);
});

test("comment: retired usages get their own warn-only section", () => {
  const body = buildComment({ deprecationLines: ["- `src/api.ts:4` — Uses retired axios — use lib/http.client (decision #d1aaaaaa)"] });
  assert.match(body, /retired usage added/);
  assert.ok(body.includes("src/api.ts:4"));
  assert.match(body, /Warning only/);
  assert.ok(!body.includes("missing binding decision"));
});
