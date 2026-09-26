import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchSelectors, resolveApplicability, type ActiveAssignment, type WorkContext } from "./resolve.js";

const ctx = (over: Partial<WorkContext> = {}): WorkContext => ({
  projectId: "p1",
  repoId: "r1",
  paths: ["src/api/users.ts"],
  taskType: "code",
  memberId: "m1",
  teamIds: ["t-backend"],
  ...over,
});
const skill = (itemId: string, versionId: string, version = 1) => ({ itemId, versionId, kind: "skill" as const, name: itemId, version });
const std = (itemId: string, versionId: string) => ({
  itemId,
  versionId,
  kind: "standard" as const,
  name: itemId,
  version: 1,
  requirements: [
    { key: "req_aaaaaaaa", text: "Document compatibility", level: "required" },
    { key: "req_bbbbbbbb", text: "Add tests", level: "recommended" },
  ],
});
const asg = (id: string, over: Partial<ActiveAssignment>): ActiveAssignment => ({
  assignmentId: id,
  name: id,
  revision: 1,
  level: "required",
  selectors: {},
  pilot: null,
  items: [],
  ...over,
});

test("globs: ** spans directories, * stays within a segment", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/c.ts"));
  assert.ok(globToRegExp("docs/prd-?.md").test("docs/prd-1.md"));
});

test("OR within a selector, AND across dimensions", () => {
  assert.equal(matchSelectors({ repos: ["r9", "r1"] }, ctx()).ok, true, "OR across repos");
  assert.equal(matchSelectors({ repos: ["r1"], taskTypes: ["prd"] }, ctx()).ok, false, "AND with task type");
  assert.equal(matchSelectors({ repos: ["r1"], taskTypes: ["prd", "code"] }, ctx()).ok, true);
  assert.equal(matchSelectors({ audience: { kind: "teams", ids: ["t-frontend"] } }, ctx()).ok, false);
  assert.equal(matchSelectors({ audience: { kind: "teams", ids: ["t-backend"] } }, ctx()).ok, true);
  assert.equal(matchSelectors({ pathGlobs: ["web/**"] }, ctx()).ok, false);
});

test("unknown context is reported, never a confident match", () => {
  const m = matchSelectors({ taskTypes: ["code"], pathGlobs: ["src/**"] }, ctx({ taskType: null, paths: null }));
  assert.deepEqual(m, { ok: false, missing: ["task type", "file paths"] });
  const r = resolveApplicability(ctx({ taskType: null }), [asg("a1", { selectors: { taskTypes: ["code"] }, items: [skill("s1", "v1")] })], []);
  assert.equal(r.skills.length, 0);
  assert.deepEqual(r.unknown, [{ assignmentId: "a1", name: "a1", missing: ["task type"] }]);
});

test("baseline + narrower assignments are cumulative; the same version is delivered once", () => {
  const r = resolveApplicability(
    ctx(),
    [
      asg("base", { items: [skill("s1", "v1"), std("st1", "sv1")] }),
      asg("backend", { selectors: { repos: ["r1"] }, items: [skill("s1", "v1"), skill("s2", "v2")] }),
    ],
    [],
  );
  assert.deepEqual(
    r.skills.map((s) => [s.itemId, s.reasons.map((x) => x.assignmentId)]),
    [
      ["s1", ["backend", "base"]],
      ["s2", ["backend"]],
    ],
  );
  assert.equal(r.standards.length, 1);
  assert.deepEqual(r.skills[0]!.reasons.find((x) => x.assignmentId === "base")!.matched, ["organization baseline"]);
});

test("conflicting versions of one item are blocked, never last-write-wins (A6)", () => {
  const r = resolveApplicability(
    ctx(),
    [asg("a", { items: [skill("s1", "v1", 1)] }), asg("b", { selectors: { repos: ["r1"] }, items: [skill("s1", "v2", 2)] })],
    [],
  );
  assert.equal(r.skills.length, 0);
  assert.equal(r.blocked.length, 1);
  assert.deepEqual(r.blocked[0]!.versions.map((v) => v.versionId), ["v1", "v2"]);
});

test("required wins over recommended when both assign the same version", () => {
  const r = resolveApplicability(ctx(), [asg("a", { level: "recommended", items: [skill("s1", "v1")] }), asg("b", { items: [skill("s1", "v1")] })], []);
  assert.equal(r.skills[0]!.level, "required");
});

test("pilot narrows the population", () => {
  const a = asg("a", { items: [skill("s1", "v1")], pilot: { audience: { kind: "members", ids: ["m2"] } } });
  assert.equal(resolveApplicability(ctx(), [a], []).skills.length, 0);
  assert.equal(resolveApplicability(ctx({ memberId: "m2" }), [a], []).skills.length, 1);
});

test("unrelated projects receive no project-scoped package (A4)", () => {
  const a = asg("a", { selectors: { projects: ["p1"] }, items: [skill("s1", "v1")] });
  assert.equal(resolveApplicability(ctx({ projectId: "p2", repoId: null }), [a], []).skills.length, 0);
});

test("approved exceptions apply only to their exact version, scope and until expiry", () => {
  const a = asg("a", { items: [std("st1", "sv1"), skill("s1", "v1")] });
  const now = new Date("2026-09-25T00:00:00Z");
  const ex = [
    { id: "e1", target: "requirement" as const, itemId: "st1", versionId: "sv1", requirementKey: "req_aaaaaaaa", scope: { repoId: "r1" }, expiresAt: null },
    { id: "e2", target: "skill_assignment" as const, itemId: "s1", versionId: "v1", requirementKey: null, scope: {}, expiresAt: new Date("2026-09-01T00:00:00Z") },
  ];
  const r = resolveApplicability(ctx(), [a], ex, now);
  assert.deepEqual(r.standards[0]!.requirements.map((q) => [q.key, q.exempt]), [
    ["req_aaaaaaaa", true],
    ["req_bbbbbbbb", false],
  ]);
  assert.equal(r.skills[0]!.exempt, false, "expired exception no longer applies");
  const other = resolveApplicability(ctx({ repoId: "r2" }), [a], ex, now);
  assert.equal(other.standards[0]!.requirements[0]!.exempt, false, "scope doesn't match another repo");
});

test("resolution is deterministic regardless of input order", () => {
  const list = [asg("b", { items: [skill("s2", "v2")] }), asg("a", { items: [skill("s1", "v1")] })];
  assert.deepEqual(resolveApplicability(ctx(), list, []), resolveApplicability(ctx(), [...list].reverse(), []));
});
