import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest } from "./manifest.js";

const tmp = () => mkdtemp(join(tmpdir(), "lockstep-manifest-"));

test("writeManifest round-trips through readManifest", async () => {
  const dir = await tmp();
  await writeManifest(dir, { produces: ["http:POST /a"], consumes: ["http:GET /b"] });
  assert.deepEqual(readManifest(dir), { produces: ["http:POST /a"], consumes: ["http:GET /b"] });
});

test("merges with (never drops) existing human entries", async () => {
  const dir = await tmp();
  await writeFile(
    join(dir, "lockstep.yaml"),
    "# my notes\nproduces:\n  - http:POST /a\nconsumes:\n  - http:GET /manual\n",
  );
  await writeManifest(dir, { produces: ["http:POST /a", "http:GET /new"], consumes: ["http:GET /b"] });
  const m = readManifest(dir);
  assert.deepEqual(m.produces, ["http:POST /a", "http:GET /new"]);
  assert.deepEqual(m.consumes, ["http:GET /manual", "http:GET /b"], "human entry kept, new one appended");
  const raw = await readFile(join(dir, "lockstep.yaml"), "utf8");
  assert.ok(raw.startsWith("# my notes"), "existing comment header preserved");
});

test("writes a one-time .lockstep.bak and is idempotent on no-op re-write", async () => {
  const dir = await tmp();
  await writeFile(join(dir, "lockstep.yaml"), "produces:\nconsumes:\n");
  await writeManifest(dir, { produces: ["http:POST /a"], consumes: [] });
  await access(join(dir, "lockstep.yaml.lockstep.bak")); // throws if missing
  const first = await readFile(join(dir, "lockstep.yaml"), "utf8");
  const status = await writeManifest(dir, { produces: ["http:POST /a"], consumes: [] });
  const second = await readFile(join(dir, "lockstep.yaml"), "utf8");
  assert.equal(first, second, "re-write with same content is a no-op");
  assert.match(status, /^unchanged/);
});

test("dry-run does not write the file", async () => {
  const dir = await tmp();
  const status = await writeManifest(dir, { produces: ["http:POST /a"], consumes: [] }, { dryRun: true });
  assert.match(status, /^would write/);
  await assert.rejects(access(join(dir, "lockstep.yaml")));
});
