import { and, desc, eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import {
  projects,
  repos,
  members,
  questions,
  tasks,
  auditEvents,
  decisions,
  decisionVersions,
  dependencyEdges,
  contracts,
} from "../db/schema.js";
import { inArray } from "drizzle-orm";

export async function orgOverview(orgId: string): Promise<{
  projects: Array<{ id: string; name: string; repos: Array<{ gitRemote: string }> }>;
  members: Array<{ id: string; githubLogin: string }>;
}> {
  return withOrg(orgId, async (tx) => {
    const ps = await tx.select().from(projects).where(eq(projects.orgId, orgId));
    const rs = await tx.select().from(repos).where(eq(repos.orgId, orgId));
    const ms = await tx.select().from(members).where(eq(members.orgId, orgId));
    return {
      // Include each project's connected repos so the CLI can resolve which project a repo belongs
      // to by its git remote (e.g. for `lockstep invite`) instead of guessing from the remote name.
      projects: ps.map((p) => ({
        id: p.id,
        name: p.name,
        repos: rs.filter((r) => r.projectId === p.id).map((r) => ({ gitRemote: r.gitRemote })),
      })),
      members: ms.map((m) => ({ id: m.id, githubLogin: m.githubLogin })),
    };
  });
}

export async function projectOverview(orgId: string, projectId: string) {
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    const decisionList = [];
    for (const d of ds) {
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      decisionList.push({
        id: d.id,
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        status: d.status,
        version: d.currentVersion,
        ruleText: v?.ruleText ?? "",
      });
    }
    const qs = (await tx.select().from(questions).where(eq(questions.projectId, projectId))).map((q) => ({
      id: q.id,
      body: q.body,
      status: q.status,
      scopeRef: q.scopeRef,
      urgent: q.urgent,
    }));
    const tks = (await tx.select().from(tasks).where(eq(tasks.projectId, projectId))).map((t) => ({
      id: t.id,
      title: t.title,
      runState: t.runState,
      status: t.status,
    }));
    const rps = (await tx.select().from(repos).where(eq(repos.projectId, projectId))).map((r) => ({
      id: r.id,
      gitRemote: r.gitRemote,
    }));
    const repoIds = rps.map((r) => r.id);
    const deps = (
      await tx
        .select()
        .from(dependencyEdges)
        .where(and(eq(dependencyEdges.projectId, projectId), eq(dependencyEdges.active, true)))
    ).map((d) => ({
      id: d.id,
      consumerRepoId: d.consumerRepoId,
      producedRepoId: d.producedRepoId,
      producedSurface: d.producedSurface,
      source: d.source,
    }));
    const contractRows = repoIds.length
      ? (await tx.select().from(contracts).where(inArray(contracts.repoId, repoIds))).map((c) => ({
          id: c.id,
          repoId: c.repoId,
          surface: c.surface,
          verified: c.verified,
          verificationStatus: c.verificationStatus,
          version: c.version,
        }))
      : [];
    const audit = (
      await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.projectId, projectId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(50)
    ).map((a) => ({ action: a.action, entityKind: a.entityKind, createdAt: a.createdAt }));
    return {
      decisions: decisionList,
      questions: qs,
      tasks: tks,
      repos: rps,
      dependencies: deps,
      contracts: contractRows,
      audit,
    };
  });
}
