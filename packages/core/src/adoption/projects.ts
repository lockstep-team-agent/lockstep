import { and, eq } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import { projects, repos, members } from "../db/schema.js";
import { getProjectRoleTx, projectArchived } from "../auth/permissions.js";
import { createOrg, createProject, connectRepo } from "../auth/auth-service.js";
import type { Principal } from "../auth/tokens.js";
import { fail, usage } from "./service.js";

export async function createPilotProject(p: Principal, name: string, orgId?: string) {
  const org = orgId ?? (await createOrg(p, `${p.githubLogin}'s workspace`)).orgId;
  const { projectId } = await createProject(p, org, name);
  await withOrg(org, (tx) => tx.update(projects).set({ settings: { adoption: { pilot: true }, productLayer: { enabled: true } } }).where(eq(projects.id, projectId)));
  const member = await withOrg(org, async (tx) => (await tx.select().from(members).where(eq(members.principalId, p.id)).limit(1))[0]!);
  await usage({ orgId: org, projectId, memberId: member.id }, "project_started", projectId);
  return { orgId: org, projectId };
}

/** Trusted auth resolution: a project ID chooses a destination; it never grants access. */
export async function connectExactProject(p: Principal, projectId: string, gitRemote: string) {
  const destination = await withSystem(async (tx) => {
    const project = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    if (!project || projectArchived(project.settings)) throw fail("project unavailable or access not granted", 403);
    const member = (await tx.select().from(members).where(and(eq(members.orgId, project.orgId), eq(members.principalId, p.id))).limit(1))[0];
    if (!member || !(await getProjectRoleTx(tx, project.id, member.id))) throw fail("accept a project invitation before connecting", 403);
    return project;
  });
  const existing = await withOrg(destination.orgId, async (tx) => (await tx.select().from(repos).where(eq(repos.gitRemote, gitRemote)).limit(1))[0]);
  if (existing && existing.projectId !== projectId) throw fail("repo is already connected to another project in this workspace", 409);
  if (!existing) await connectRepo(p, destination.orgId, projectId, gitRemote);
  return { orgId: destination.orgId, projectId, projectName: destination.name, status: existing ? "already-connected" : "joined" };
}
