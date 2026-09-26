/** Shared fixtures for the standards e2e suites (Postgres). */
import { eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { members, principals, projectMembers, projects, repos } from "../db/schema.js";
import { issueTokenTx } from "../auth/tokens.js";
import { createOrg } from "../auth/auth-service.js";
import { createItem, publishVersion, saveDraft } from "./catalog.js";

export const one = <T>(r: T[]): T => r[0]!;
let seq = Date.now() + 998_000_000;
export const uid = () => ++seq;
export const b64 = (s: string) => Buffer.from(s).toString("base64");
export const enc = (s: string) => new TextEncoder().encode(s);

/** An org whose creator (cto) is the owner, plus a plain member (eng) and one project/repo. */
export async function setup() {
  const n = uid();
  const cto = await withSystem(async (tx) => one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `cto-${n}` }).returning()));
  const { orgId } = await createOrg({ id: cto.id, githubUserId: cto.githubUserId, githubLogin: cto.githubLogin } as never, `Std-${n}`);
  return withSystem(async (tx) => {
    const ctoMember = one(await tx.select().from(members).where(eq(members.principalId, cto.id)));
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `eng-${n}` }).returning());
    const eng = one(await tx.insert(members).values({ orgId, principalId: p.id, githubUserId: p.githubUserId, githubLogin: p.githubLogin }).returning());
    const proj = one(await tx.insert(projects).values({ orgId, name: "api", createdBy: ctoMember.id }).returning());
    for (const m of [ctoMember, eng]) {
      await tx.insert(projectMembers).values({ orgId, projectId: proj.id, memberId: m.id, invitedGithubLogin: m.githubLogin, role: "member", status: "active" });
    }
    const repo = one(await tx.insert(repos).values({ orgId, projectId: proj.id, gitRemote: `github.com/acme/api-${n}` }).returning());
    return {
      orgId,
      projectId: proj.id,
      repoId: repo.id,
      cto: ctoMember.id,
      eng: eng.id,
      ctoToken: await issueTokenTx(tx, cto.id),
      engToken: await issueTokenTx(tx, p.id),
    };
  });
}
export type S = Awaited<ReturnType<typeof setup>>;

export async function publishedStandard(s: S, text = "Public API changes document compatibility") {
  const { itemId, versionId } = await createItem(s.orgId, s.cto, {
    kind: "standard",
    name: `API changes ${uid()}`,
    content: { purpose: "Keep consumers safe", taskTypes: ["code"], requirements: [{ text, level: "required" }, { text: "Add tests", level: "recommended" }] },
  });
  await publishVersion(s.orgId, s.cto, versionId);
  return { itemId, versionId };
}

export async function publishedSkill(s: S) {
  const { itemId, versionId } = await createItem(s.orgId, s.cto, { kind: "skill", name: `api-review ${uid()}`, content: { purpose: "Review API diffs" } });
  const { storePackage } = await import("./packages.js");
  const pkg = await storePackage(s.orgId, [{ path: "SKILL.md", bytes: enc("---\nname: api-review\n---\nReview.") }], null);
  const d = await saveDraft(s.orgId, s.cto, itemId, { content: { purpose: "Review API diffs" }, packageId: pkg.id });
  await publishVersion(s.orgId, s.cto, d.versionId);
  return { itemId, versionId: d.versionId };
}
