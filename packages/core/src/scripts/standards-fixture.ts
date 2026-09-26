/**
 * Standards & Skills scale fixture (PRD §12): 1,000 enrolled environments, 200 repositories,
 * 200 standards, 500 skills and 10,000 receipts, with overlapping assignments (org baseline,
 * per-project, per-repo, team audiences, path/task scopes). Catalog content goes through the real
 * services (publish validation, packages, releases); environments and receipts are bulk-inserted.
 *
 *   BLOB_DIR=… tsx src/scripts/standards-fixture.ts     # same BLOB_* settings as the running core
 *
 * Prints { orgId, login, githubUserId } — sign in with dev-login as that user, then run
 * standards-timing.ts against the org.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import { environments, members, orgRoles, principals, projectMembers, projects, receipts, repos, teams, teamMembers } from "../db/schema.js";
import { createOrg } from "../auth/auth-service.js";
import { createItem, publishVersion, saveDraft } from "../standards/catalog.js";
import { storePackage } from "../standards/packages.js";
import { applyChange } from "../standards/rollouts.js";
import { resolutionInputsTx, resolveEnv } from "../standards/environments.js";

const N = { projects: 20, reposPerProject: 10, members: 100, teams: 10, standards: 200, skills: 500, envs: 1000, receipts: 10_000 };
const stamp = Date.now().toString(36);
const one = <T>(r: T[]): T => r[0]!;
let seed = 7;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
const pickN = <T>(xs: T[], n: number): T[] => [...xs].sort(() => rand() - 0.5).slice(0, n);
const hex = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const t0 = Date.now();
const log = (m: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function main() {
  const githubUserId = 1_000_000_000 + (Date.now() % 1_000_000_000); // unique per run
  const login = `std-owner-${stamp}`;
  const owner = await withSystem(async (tx) => one(await tx.insert(principals).values({ githubUserId, githubLogin: login }).returning()));
  const { orgId } = await createOrg(owner as never, `Standards scale ${stamp}`);
  const ownerMember = await withSystem(async (tx) => one(await tx.select().from(members).where(eq(members.principalId, owner.id))));

  // people, teams, projects, repos
  const { memberIds, projectIds, repoRows, teamIds } = await withSystem(async (tx) => {
    const ps = await tx.insert(principals).values(Array.from({ length: N.members }, (_, i) => ({ githubUserId: githubUserId + 1 + i, githubLogin: `std-${stamp}-${i}` }))).returning();
    const ms = await tx.insert(members).values(ps.map((p) => ({ orgId, principalId: p.id, githubUserId: p.githubUserId, githubLogin: p.githubLogin }))).returning();
    const memberIds = [ownerMember.id, ...ms.map((m) => m.id)];
    await tx.insert(orgRoles).values({ orgId, memberId: ms[0]!.id, role: "admin" });
    const pr = await tx.insert(projects).values(Array.from({ length: N.projects }, (_, i) => ({ orgId, name: `Service ${i}`, createdBy: ownerMember.id }))).returning();
    const rr = await tx
      .insert(repos)
      .values(pr.flatMap((p, i) => Array.from({ length: N.reposPerProject }, (_, j) => ({ orgId, projectId: p.id, gitRemote: `github.com/scale-${stamp}/svc${i}-repo${j}` }))))
      .returning();
    const loginOf = new Map([[ownerMember.id, ownerMember.githubLogin], ...ms.map((m) => [m.id, m.githubLogin] as const)]);
    await tx.insert(projectMembers).values(pr.flatMap((p) => memberIds.map((m) => ({ orgId, projectId: p.id, memberId: m, invitedGithubLogin: loginOf.get(m)!, role: "member", status: "active" }))));
    const ts = await tx.insert(teams).values(Array.from({ length: N.teams }, (_, i) => ({ orgId, slug: `team-${i}`, name: `Team ${i}`, createdBy: ownerMember.id }))).returning();
    await tx.insert(teamMembers).values(memberIds.map((m, i) => ({ orgId, teamId: ts[i % N.teams]!.id, memberId: m, addedBy: ownerMember.id })));
    return { memberIds, projectIds: pr.map((p) => p.id), repoRows: rr, teamIds: ts.map((t) => t.id) };
  });
  log(`org ${orgId}: ${memberIds.length} members, ${projectIds.length} projects, ${repoRows.length} repos`);

  // 500 skills with small packages, 200 standards (5 requirements each)
  const skillV: string[] = [];
  for (let i = 0; i < N.skills; i++) {
    const { itemId } = await createItem(orgId, ownerMember.id, { kind: "skill", name: `skill-${i}`, content: { purpose: `Skill ${i}`, whenToUse: `when working on area ${i % 40}` } });
    const pkg = await storePackage(orgId, [{ path: "SKILL.md", bytes: new TextEncoder().encode(`---\nname: skill-${i}\ndescription: area ${i % 40}\n---\nSteps for ${i}.`) }, { path: "reference.md", bytes: new TextEncoder().encode(`ref ${i}`) }], null);
    const d = await saveDraft(orgId, ownerMember.id, itemId, { content: { purpose: `Skill ${i}`, whenToUse: `when working on area ${i % 40}` }, packageId: pkg.id });
    await publishVersion(orgId, ownerMember.id, d.versionId);
    skillV.push(d.versionId);
  }
  log(`${skillV.length} skills published`);
  const stdV: string[] = [];
  for (let i = 0; i < N.standards; i++) {
    const { versionId } = await createItem(orgId, ownerMember.id, {
      kind: "standard",
      name: `standard-${i}`,
      content: { purpose: `Standard ${i}`, taskTypes: i % 3 ? ["code"] : ["code", "prd"], requirements: Array.from({ length: 5 }, (_, k) => ({ text: `Requirement ${k} of standard ${i}`, level: k < 3 ? "required" : "recommended" })) },
    });
    await publishVersion(orgId, ownerMember.id, versionId);
    stdV.push(versionId);
  }
  log(`${stdV.length} standards published`);

  // assignments: org baseline, one per project, some per repo / team / path scope
  const assign = (versionIds: string[], selectors: object, level: "required" | "recommended" = "required") =>
    applyChange(orgId, ownerMember.id, { kind: "create", versionIds, selectors, level });
  await assign([...skillV.slice(0, 20), ...stdV.slice(0, 10)], {});
  for (let p = 0; p < N.projects; p++) await assign([...skillV.slice(20 + p * 20, 40 + p * 20), ...stdV.slice(10 + p * 8, 18 + p * 8)], { projects: [projectIds[p]!] });
  for (let t = 0; t < N.teams; t++) await assign(skillV.slice(420 + t * 8, 428 + t * 8), { audience: { kind: "teams", ids: [teamIds[t]!] } }, "recommended");
  for (let r = 0; r < 40; r++) await assign(pickN(stdV.slice(170), 3), { repos: [repoRows[r * 5]!.id], pathGlobs: ["src/api/**"], taskTypes: ["code"] });
  log("assignments created");

  // 1,000 environments: the owner holds 50 (so timing can authenticate), the rest spread over members/repos
  const envRows = Array.from({ length: N.envs }, (_, i) => {
    const repo = repoRows[i % repoRows.length]!;
    return {
      orgId,
      memberId: i < 50 ? ownerMember.id : memberIds[1 + (i % (memberIds.length - 1))]!,
      adapter: "claude",
      adapterVersion: "0.4.0",
      hostKey: hex(`${stamp}-${i}`),
      projectId: repo.projectId,
      repoId: repo.id,
      capabilities: { install: true, sessionAvailability: true, invocation: "unobservable" as const, checks: true },
    };
  });
  const envs = await withOrg(orgId, (tx) => tx.insert(environments).values(envRows).returning());
  log(`${envs.length} environments`);

  // 10,000 receipts: installed for what each env should hold (some for older content), plus synced/session rows
  const rows = await withOrg(orgId, async (tx) => {
    const inp = await resolutionInputsTx(tx, orgId);
    const tm = await tx.select().from(teamMembers).where(eq(teamMembers.orgId, orgId));
    const out: Array<typeof receipts.$inferInsert> = [];
    for (const e of envs) {
      if (out.length >= N.receipts) break;
      const r = resolveEnv(e, tm.filter((t) => t.memberId === e.memberId).map((t) => t.teamId), inp.assignments, inp.exceptions, inp.packages);
      const at = new Date(Date.now() - Math.floor(rand() * 7 * 864e5));
      for (const d of r.desired.slice(0, 9)) out.push({ orgId, envId: e.id, kind: rand() < 0.03 ? "failed" : "installed", itemId: d.itemId, versionId: d.versionId, packageHash: d.packageHash, generation: r.generation, observedAt: at, detail: null });
      out.push({ orgId, envId: e.id, kind: "synced", generation: r.generation, observedAt: at, detail: null });
    }
    return out.slice(0, N.receipts);
  });
  for (let i = 0; i < rows.length; i += 1000) await withOrg(orgId, (tx) => tx.insert(receipts).values(rows.slice(i, i + 1000)));
  log(`${rows.length} receipts`);
  process.stdout.write(JSON.stringify({ orgId, login, githubUserId, repoRemote: repoRows[0]!.gitRemote }) + "\n");
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
