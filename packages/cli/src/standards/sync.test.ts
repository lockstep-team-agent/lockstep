/**
 * Managed-skill sync against a temp git checkout and a fake server: install, idempotent re-sync,
 * local-edit conflict + restore/keep, interrupted swaps, removal ownership, integrity, git-tracked
 * protection, lost receipts, lock contention, folder identity and v1 state migration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderFor, packageHashOf, readState, skillsRoot, SyncBusy, syncSkills, type DesiredSkill, type Receipt, type SyncApi } from "./sync.js";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function checkout(): string {
  const cwd = mkdtempSync(join(tmpdir(), "lockstep-skills-"));
  execFileSync("git", ["init", "-q", cwd]);
  return cwd;
}

/** A fake server holding blobs and a mutable desired set; records receipts. */
function fake() {
  const blobs = new Map<string, Uint8Array>();
  let desired: DesiredSkill[] = [];
  const got: Array<{ generation: string; results: Receipt[] }> = [];
  const prefs: Array<[string, string]> = [];
  let failReceipts = 0;
  let down = false;
  const skill = (slug: string, version: number, files: Record<string, string>, level: "required" | "recommended" = "required"): DesiredSkill => {
    const manifest = Object.entries(files).map(([path, body]) => {
      const bytes = new TextEncoder().encode(body);
      blobs.set(sha(bytes), bytes);
      return { path, sha256: sha(bytes), size: bytes.byteLength, mode: 0o644 };
    });
    const id = sha(slug).slice(0, 12);
    return { slug, itemId: `00000000-0000-0000-0000-${id}`, versionId: `10000000-0000-0000-0000-00000000000${version}`, name: slug, version, level, packageHash: packageHashOf(manifest), files: manifest };
  };
  const api: SyncApi = {
    sync: async () => {
      if (down) throw new Error("fetch failed");
      return { generation: sha(JSON.stringify(desired.map((d) => d.packageHash))).slice(0, 32), desired, offered: [], declined: [], blocked: [] };
    },
    blob: async (h) => {
      const b = blobs.get(h);
      if (!b) throw new Error("download failed (404)");
      return b;
    },
    receipts: async (generation, results) => {
      if (failReceipts > 0) {
        failReceipts--;
        throw new Error("fetch failed");
      }
      got.push({ generation, results });
      return { current: true };
    },
    preference: async (itemId, choice) => void prefs.push([itemId, choice]),
  };
  return {
    api,
    blobs,
    got,
    prefs,
    skill,
    set: (d: DesiredSkill[]) => (desired = d),
    failNextReceipts: (n = 1) => (failReceipts = n),
    offline: (v: boolean) => (down = v),
  };
}

const kinds = (f: ReturnType<typeof fake>) => f.got.at(-1)!.results.map((r) => r.kind);
const dirOf = (cwd: string, d: DesiredSkill) => join(skillsRoot(cwd), folderFor(d.slug, d.itemId));

test("installs, re-syncs idempotently, updates by swap, and removes only what it manages", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "---\nname: api-review\n---\nv1", "ref/notes.md": "notes" });
  f.set([v1]);
  const r1 = await syncSkills(cwd, f.api);
  assert.deepEqual(r1.installed, ["api-review"]);
  const dir = dirOf(cwd, v1);
  assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /v1/);
  assert.equal(readFileSync(join(dir, "ref", "notes.md"), "utf8"), "notes");
  assert.deepEqual(kinds(f), ["installed", "synced"]);

  const r2 = await syncSkills(cwd, f.api);
  assert.deepEqual([r2.installed, r2.unchanged], [[], ["api-review"]], "second sync is a no-op");
  assert.deepEqual(kinds(f), ["synced"], "acknowledged receipts aren't re-sent");

  f.set([f.skill("api-review", 2, { "SKILL.md": "---\nname: api-review\n---\nv2" })]);
  const r3 = await syncSkills(cwd, f.api);
  assert.deepEqual(r3.updated, ["api-review"]);
  assert.ok(!existsSync(join(dir, "ref")), "the old tree is replaced, not merged");

  mkdirSync(join(skillsRoot(cwd), "my-own"), { recursive: true });
  writeFileSync(join(skillsRoot(cwd), "my-own", "SKILL.md"), "mine");
  f.set([]);
  const r4 = await syncSkills(cwd, f.api);
  assert.deepEqual(r4.removed, ["api-review"]);
  assert.ok(!existsSync(dir));
  assert.equal(readFileSync(join(skillsRoot(cwd), "my-own", "SKILL.md"), "utf8"), "mine");
});

test("a lost receipt is re-sent; a repaired conflict reports installed again (review #3)", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  f.set([v1]);
  f.failNextReceipts();
  await assert.rejects(syncSkills(cwd, f.api), /fetch failed/);
  assert.equal(f.got.length, 0);
  await syncSkills(cwd, f.api);
  assert.deepEqual(kinds(f), ["installed", "synced"], "the missing installed observation is re-sent");

  writeFileSync(join(dirOf(cwd, v1), "SKILL.md"), "tweak");
  f.set([f.skill("api-review", 2, { "SKILL.md": "v2" })]);
  await syncSkills(cwd, f.api);
  assert.deepEqual(kinds(f), ["conflict", "synced"]);
  // the person fixes it by hand (back to exactly v2's content)
  writeFileSync(join(dirOf(cwd, v1), "SKILL.md"), "v2");
  await syncSkills(cwd, f.api);
  assert.deepEqual(kinds(f), ["installed", "synced"], "the repaired state clears the conflict on the server");
});

test("restore only touches managed skills, and nothing is lost if the server is unreachable (review #4)", async () => {
  const cwd = checkout();
  const f = fake();
  mkdirSync(join(skillsRoot(cwd), "lockstep-org-mine"), { recursive: true });
  writeFileSync(join(skillsRoot(cwd), "lockstep-org-mine", "SKILL.md"), "personal");
  await assert.rejects(syncSkills(cwd, f.api, { restore: "mine" }), /isn't a skill Lockstep manages/);
  assert.equal(readFileSync(join(skillsRoot(cwd), "lockstep-org-mine", "SKILL.md"), "utf8"), "personal");

  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  f.set([v1]);
  await syncSkills(cwd, f.api);
  writeFileSync(join(dirOf(cwd, v1), "SKILL.md"), "my edits");
  f.offline(true);
  await assert.rejects(syncSkills(cwd, f.api, { restore: "api-review" }), /fetch failed/);
  assert.equal(readFileSync(join(dirOf(cwd, v1), "SKILL.md"), "utf8"), "my edits", "offline restore deletes nothing");
  f.offline(false);
  const r = await syncSkills(cwd, f.api, { restore: "api-review" });
  assert.deepEqual(r.updated, ["api-review"]);
  assert.equal(readFileSync(join(dirOf(cwd, v1), "SKILL.md"), "utf8"), "v1");
});

test("git-tracked skill folders are never replaced or removed (review #4)", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  f.set([v1]);
  await syncSkills(cwd, f.api);
  execFileSync("git", ["-C", cwd, "add", "-f", `.claude/skills/${folderFor(v1.slug, v1.itemId)}/SKILL.md`]);
  f.set([f.skill("api-review", 2, { "SKILL.md": "v2" })]);
  const r = await syncSkills(cwd, f.api);
  assert.deepEqual(r.conflicts.map((c) => c.reason), ["tracked_by_git"]);
  assert.equal(readFileSync(join(dirOf(cwd, v1), "SKILL.md"), "utf8"), "v1", "tracked content unchanged");
  f.set([]);
  assert.deepEqual((await syncSkills(cwd, f.api)).conflicts.map((c) => c.reason), ["tracked_by_git"]);
  assert.ok(existsSync(dirOf(cwd, v1)));
});

test("keep: a recommended skill is declined; a required one is reinstalled, not declined (review #7)", async () => {
  const cwd = checkout();
  const f = fake();
  const req = f.skill("api-review", 1, { "SKILL.md": "v1" });
  const rec = f.skill("style", 1, { "SKILL.md": "s1" }, "recommended");
  f.set([req, rec]);
  await syncSkills(cwd, f.api);
  writeFileSync(join(dirOf(cwd, req), "SKILL.md"), "mine");
  writeFileSync(join(dirOf(cwd, rec), "SKILL.md"), "mine too");

  const r = await syncSkills(cwd, f.api, { keepPersonal: "api-review" });
  assert.equal(readFileSync(join(skillsRoot(cwd), "api-review-personal", "SKILL.md"), "utf8"), "mine");
  assert.equal(f.prefs.length, 0, "required skills are never declined");
  assert.ok(r.installed.includes("api-review"), "the org version comes back");
  assert.equal(readFileSync(join(dirOf(cwd, req), "SKILL.md"), "utf8"), "v1");

  await syncSkills(cwd, f.api, { keepPersonal: "style" });
  assert.deepEqual(f.prefs, [[rec.itemId, "decline"]]);
});

test("an interrupted swap is rolled back; concurrent syncs are refused (review #6)", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  f.set([v1]);
  await syncSkills(cwd, f.api);
  const folder = folderFor(v1.slug, v1.itemId);
  // crash between "old → trash" and "staging → place": the destination is missing
  mkdirSync(join(skillsRoot(cwd), ".lockstep-trash", "deadbeef"), { recursive: true });
  execFileSync("mv", [join(skillsRoot(cwd), folder), join(skillsRoot(cwd), ".lockstep-trash", "deadbeef", folder)]);
  mkdirSync(join(skillsRoot(cwd), ".lockstep-staging", "deadbeef", folder), { recursive: true });
  const r = await syncSkills(cwd, f.api);
  assert.deepEqual([r.unchanged, r.conflicts], [["api-review"], []], "the old copy is restored, then recognized");
  assert.equal(readFileSync(join(dirOf(cwd, v1), "SKILL.md"), "utf8"), "v1");
  assert.ok(!existsSync(join(skillsRoot(cwd), ".lockstep-trash")));

  // a live lock held by this process (another run) → refused
  writeFileSync(join(skillsRoot(cwd), ".lockstep-sync.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  await assert.rejects(syncSkills(cwd, f.api), SyncBusy);
  // a dead holder's lock is taken over
  writeFileSync(join(skillsRoot(cwd), ".lockstep-sync.lock"), JSON.stringify({ pid: 999_999_9, at: Date.now() }));
  await syncSkills(cwd, f.api);
  assert.ok(!existsSync(join(skillsRoot(cwd), ".lockstep-sync.lock")), "lock released");
});

test("distinct items never share a folder, even with long colliding slugs (review #15)", async () => {
  const a = "a".repeat(60);
  assert.notEqual(folderFor(a, "11111111-0000-0000-0000-000000000000"), folderFor(`${a}-b123`, "22222222-0000-0000-0000-000000000000"));
  const cwd = checkout();
  const f = fake();
  const x = f.skill(a, 1, { "SKILL.md": "x" });
  const y = f.skill(`${a}-b123`, 1, { "SKILL.md": "y" });
  f.set([x, y]);
  const r = await syncSkills(cwd, f.api);
  assert.equal(r.installed.length, 2);
  assert.equal(readFileSync(join(dirOf(cwd, x), "SKILL.md"), "utf8"), "x");
  assert.equal(readFileSync(join(dirOf(cwd, y), "SKILL.md"), "utf8"), "y");
});

test("v1 state is migrated in place: existing folders are kept and re-reported", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  mkdirSync(join(skillsRoot(cwd), "lockstep-org-api-review"), { recursive: true });
  writeFileSync(join(skillsRoot(cwd), "lockstep-org-api-review", "SKILL.md"), "v1");
  writeFileSync(
    join(skillsRoot(cwd), ".lockstep-managed.json"),
    JSON.stringify({ version: 1, generation: null, syncedAt: null, skills: { "api-review": { itemId: v1.itemId, versionId: v1.versionId, version: 1, name: "api-review", packageHash: v1.packageHash, files: { "SKILL.md": sha("v1") } } } }),
  );
  f.set([v1]);
  const r = await syncSkills(cwd, f.api);
  assert.deepEqual(r.unchanged, ["api-review"]);
  assert.equal(readState(cwd).skills[v1.itemId]!.folder, "lockstep-org-api-review");
  assert.deepEqual(kinds(f), ["installed", "synced"], "evidence is re-established after migration");
});

test("integrity: a tampered blob or manifest installs nothing and keeps the existing copy", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  f.set([v1]);
  await syncSkills(cwd, f.api);
  const v2 = f.skill("api-review", 2, { "SKILL.md": "v2" });
  f.blobs.set(v2.files[0]!.sha256, new TextEncoder().encode("evil"));
  f.set([v2]);
  const r = await syncSkills(cwd, f.api);
  assert.deepEqual(r.failed.map((x) => x.code), ["integrity"]);
  assert.equal(readFileSync(join(dirOf(cwd, v1), "SKILL.md"), "utf8"), "v1");

  f.set([f.skill("escape", 1, { "../../evil.md": "x" })]);
  const esc = await syncSkills(cwd, f.api);
  assert.deepEqual(esc.failed.map((x) => x.code), ["invalid_package"]);
  assert.ok(!existsSync(join(cwd, ".claude", "evil.md")));

  const gone = f.skill("missing", 1, { "SKILL.md": "m" });
  f.blobs.delete(gone.files[0]!.sha256);
  f.set([gone]);
  assert.deepEqual((await syncSkills(cwd, f.api)).failed.map((x) => x.code), ["network"], "download failures are retryable");
});

test(".git/info/exclude gets one managed block, idempotently", async () => {
  const cwd = checkout();
  const f = fake();
  f.set([f.skill("api-review", 1, { "SKILL.md": "v1" })]);
  await syncSkills(cwd, f.api);
  await syncSkills(cwd, f.api);
  const ex = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
  assert.equal(ex.match(/>>> lockstep managed skills/g)?.length, 1);
  const status = execFileSync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  assert.equal(status.trim(), "", "managed skills and state never show up as untracked");
});

test("the sync deadline is absolute: once passed, no further request is started (review #17)", async () => {
  const { httpApi } = await import("./client.js");
  const api = httpApi("env", "session", Date.now() - 1);
  let fetched = false;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ((fetched = true), new Response("{}"))) as typeof fetch;
  try {
    await assert.rejects(async () => api.sync(), /deadline/);
    await assert.rejects(api.blob("0".repeat(64)), /deadline/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = real;
  }
});

test("a failed removal receipt is re-sent until acknowledged (verification F3)", async () => {
  const cwd = checkout();
  const f = fake();
  const v1 = f.skill("api-review", 1, { "SKILL.md": "v1" });
  f.set([v1]);
  await syncSkills(cwd, f.api);
  f.set([]);
  f.failNextReceipts();
  await assert.rejects(syncSkills(cwd, f.api), /fetch failed/);
  assert.ok(!existsSync(dirOf(cwd, v1)), "the folder is removed");
  const again = await syncSkills(cwd, f.api);
  assert.deepEqual(again.removed, []);
  assert.deepEqual(kinds(f), ["removed", "synced"], "the removal is reported on the next sync");
  await syncSkills(cwd, f.api);
  assert.deepEqual(kinds(f), ["synced"], "and not again once acknowledged");
  // response lost after the server committed: resent once, harmless (receipts are append-only evidence)
});

test("the org-wide user hook installs once, keeps foreign hooks, and removes cleanly", async () => {
  const home = mkdtempSync(join(tmpdir(), "lockstep-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const { installOrgSkillsHook, removeOrgSkillsHook } = await import("./client.js");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "other-tool start" }] }] } }));
    await installOrgSkillsHook();
    await installOrgSkillsHook();
    const hooks = (JSON.parse(readFileSync(settings, "utf8")) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }).hooks.SessionStart;
    assert.equal(hooks.filter((h) => h.hooks[0]!.command.includes("skills auto")).length, 1, "installed once");
    assert.ok(hooks.some((h) => h.hooks[0]!.command === "other-tool start"), "foreign hook kept");
    await removeOrgSkillsHook();
    const after = (JSON.parse(readFileSync(settings, "utf8")) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } }).hooks.SessionStart;
    assert.deepEqual(after.map((h) => h.hooks[0]!.command), ["other-tool start"]);
  } finally {
    process.env.HOME = prev;
  }
});
