import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanPath, isScript, packageHashOf, parseFrontmatter, planPackage, PackageError } from "./packages.js";
import { captureSkill, discoverSkills, gitBlobSha, parseGithubUrl } from "./github-import.js";

const enc = (s: string) => new TextEncoder().encode(s);

test("paths are relative and traversal-free", () => {
  assert.equal(cleanPath("./a/b.md"), "a/b.md");
  for (const bad of ["../x", "/etc/passwd", "a/../b", "C:/x", "a//b"]) assert.throws(() => cleanPath(bad), PackageError, bad);
});

test("packages need SKILL.md, refuse credentials, enforce limits, flag scripts", () => {
  assert.throws(() => planPackage([{ path: "README.md", bytes: enc("x") }]), /SKILL\.md/);
  assert.throws(() => planPackage([{ path: "SKILL.md", bytes: enc("x") }, { path: ".env", bytes: enc("K=1") }]), /credential/);
  assert.throws(() => planPackage([{ path: "SKILL.md", bytes: new Uint8Array(1_000_001) }]), /too large/);
  const p = planPackage([
    { path: "scripts/run.sh", bytes: enc("echo hi") },
    { path: "SKILL.md", bytes: enc("---\nname: x\n---\nbody") },
    { path: "bin/tool", bytes: enc("x"), mode: 0o755 },
  ]);
  assert.deepEqual(p.manifest.map((f) => [f.path, f.isScript]), [
    ["SKILL.md", false],
    ["bin/tool", true],
    ["scripts/run.sh", true],
  ]);
  assert.equal(isScript("notes.md"), false);
});

test("package hash is order-independent and content-sensitive", () => {
  const a = planPackage([{ path: "SKILL.md", bytes: enc("a") }, { path: "x.md", bytes: enc("x") }]);
  const b = planPackage([{ path: "x.md", bytes: enc("x") }, { path: "SKILL.md", bytes: enc("a") }]);
  const c = planPackage([{ path: "SKILL.md", bytes: enc("b") }, { path: "x.md", bytes: enc("x") }]);
  assert.equal(a.packageHash, b.packageHash);
  assert.notEqual(a.packageHash, c.packageHash);
  assert.equal(packageHashOf(a.manifest), a.packageHash);
});

test("frontmatter: scalars, inline lists, dash lists, quotes", () => {
  const { data, body } = parseFrontmatter(`---\nname: "api-change"\ndescription: Review API changes\nallowed-tools: [Read, Grep]\ntags:\n  - api\n  - review\n---\n# Body`);
  assert.deepEqual(data, { name: "api-change", description: "Review API changes", "allowed-tools": ["Read", "Grep"], tags: ["api", "review"] });
  assert.equal(body, "# Body");
  assert.deepEqual(parseFrontmatter("no frontmatter").data, {});
});

test("GitHub URLs: tree/blob forms; non-GitHub refused", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/acme/skills/tree/main/skills/api"), { owner: "acme", repo: "skills", ref: "main", path: "skills/api" });
  assert.deepEqual(parseGithubUrl("https://github.com/acme/skills.git"), { owner: "acme", repo: "skills", ref: null, path: "" });
  assert.equal(parseGithubUrl("https://github.com/acme/skills/blob/v1/a/SKILL.md").path, "a");
  assert.throws(() => parseGithubUrl("https://gitlab.com/a/b"), /github\.com/);
});

/* ── import against a stubbed GitHub ── */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const COMMIT = "a".repeat(40);
const FILES: Record<string, string> = {
  "skills/api/SKILL.md": "---\nname: api-change\ndescription: Checks public API changes\nallowed-tools: Read, Grep\n---\nDo the thing.",
  "skills/api/check.sh": "echo run",
  "skills/other/SKILL.md": "---\nname: other\n---\nx",
  LICENSE: "MIT License\n...",
};
function stubGithub(tamper = false) {
  globalThis.fetch = (async (input: string | URL) => {
    const u = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith("/repos/acme/skills")) return json({ default_branch: "main" });
    if (u.includes("/commits/")) return json({ sha: COMMIT });
    if (u.includes("/git/trees/"))
      return json({
        truncated: false,
        tree: [
          ...Object.entries(FILES).map(([path, body]) => ({ path, type: "blob", mode: path.endsWith(".sh") ? "100755" : "100644", sha: gitBlobSha(new TextEncoder().encode(body)), size: body.length })),
          { path: "skills/api/link", type: "blob", mode: "120000", sha: "b".repeat(40) },
          { path: "skills/api/vendor", type: "commit", mode: "160000", sha: "c".repeat(40) },
        ],
      });
    const raw = /raw\.githubusercontent\.com\/acme\/skills\/[0-9a-f]+\/(.+)$/.exec(u);
    if (raw) {
      const path = decodeURIComponent(raw[1]!);
      const body = FILES[path];
      if (body === undefined) return new Response("nf", { status: 404 });
      return new Response(tamper && path.endsWith("SKILL.md") ? body + "!" : body, { status: 200 });
    }
    return new Response("unexpected " + u, { status: 500 });
  }) as typeof fetch;
}

test("discover lists every SKILL.md directory under the URL path at one commit", async () => {
  stubGithub();
  const d = await discoverSkills("https://github.com/acme/skills");
  assert.equal(d.commit, COMMIT);
  assert.deepEqual(d.candidates.map((c) => [c.dir, c.name]), [
    ["skills/api", "api-change"],
    ["skills/other", "other"],
  ]);
});

test("capture takes only the selected directory, verifies blob shas, skips links/submodules (A2)", async () => {
  stubGithub();
  const c = await captureSkill({ owner: "acme", repo: "skills", ref: "main", path: "" }, COMMIT, "main", "skills/api");
  assert.deepEqual(c.files.map((f) => f.path).sort(), ["SKILL.md", "check.sh"]);
  assert.deepEqual(c.skipped.map((s) => s.path).sort(), ["skills/api/link", "skills/api/vendor"]);
  assert.deepEqual(c.scripts, ["check.sh"]);
  assert.equal(c.license, "MIT");
  assert.deepEqual(c.declared.tools, ["Read", "Grep"]);
  assert.equal(c.declared.compatibility, "known-limits");
  assert.equal(c.provenance.commit, COMMIT);
});

test("capture refuses content that doesn't match the committed blob", async () => {
  stubGithub(true);
  await assert.rejects(() => captureSkill({ owner: "acme", repo: "skills", ref: "main", path: "" }, COMMIT, "main", "skills/api"), /integrity/);
});
