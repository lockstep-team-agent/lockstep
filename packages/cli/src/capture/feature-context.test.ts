import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { writeFeatureContext, readFeatureContext, clearFeatureContext } from "./feature-context.js";

// Unique remote per run so parallel/repeat runs don't collide on the tmpdir file.
const remote = `github.com/lockstep-test/feature-ctx-${process.pid}-${Date.now()}`;
const pathFor = (r: string) =>
  join(tmpdir(), `lockstep-feature-${createHash("sha1").update(r).digest("hex").slice(0, 12)}.json`);

test("write → read round-trips the capabilityRef", () => {
  clearFeatureContext(remote);
  writeFeatureContext(remote, "feature:guest-checkout");
  assert.equal(readFeatureContext(remote), "feature:guest-checkout");
  clearFeatureContext(remote);
});

test("missing context → null", () => {
  clearFeatureContext(remote);
  assert.equal(readFeatureContext(remote), null);
});

test("stale ts (older than TTL) → null", () => {
  // Hand-write a context with a timestamp well beyond the 8h TTL.
  const stale = { ref: "feature:old", ts: Date.now() - 9 * 3600_000 };
  writeFileSync(pathFor(remote), JSON.stringify(stale));
  assert.equal(readFeatureContext(remote), null);
  clearFeatureContext(remote);
});

test("distinct remotes get distinct files", () => {
  const a = `${remote}-a`;
  const b = `${remote}-b`;
  writeFeatureContext(a, "feature:a");
  writeFeatureContext(b, "feature:b");
  assert.equal(readFeatureContext(a), "feature:a");
  assert.equal(readFeatureContext(b), "feature:b");
  clearFeatureContext(a);
  clearFeatureContext(b);
});

test("clear removes the file (read → null after)", () => {
  writeFeatureContext(remote, "feature:x");
  const p = pathFor(remote);
  assert.equal((JSON.parse(readFileSync(p, "utf8")) as { ref: string }).ref, "feature:x");
  clearFeatureContext(remote);
  assert.equal(readFeatureContext(remote), null);
});
