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
} from "../db/schema.js";

export async function orgOverview(orgId: string): Promise<{
  projects: Array<{ id: string; name: string }>;
  members: Array<{ id: string; githubLogin: string }>;
}> {
  return withOrg(orgId, async (tx) => {
    const ps = await tx.select().from(projects).where(eq(projects.orgId, orgId));
    const ms = await tx.select().from(members).where(eq(members.orgId, orgId));
    return {
      projects: ps.map((p) => ({ id: p.id, name: p.name })),
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
    const audit = (
      await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.projectId, projectId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(50)
    ).map((a) => ({ action: a.action, entityKind: a.entityKind, createdAt: a.createdAt }));
    return { decisions: decisionList, questions: qs, tasks: tks, repos: rps, audit };
  });
}
