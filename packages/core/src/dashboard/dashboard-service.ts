import { and, desc, eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import {
  orgs,
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
  projectMembers,
  answers,
  changeFeedEntries,
  decisionApprovals,
  decisionRequiredReviewers,
  decisionProvenances,
  conflicts,
} from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { projectVisibility, projectArchived } from "../auth/permissions.js";
import { confidenceFraction } from "../ledger/confidence.js";

export async function orgOverview(
  orgId: string,
  viewerMemberId?: string,
): Promise<{
  org: { id: string; name: string } | null;
  projects: Array<{ id: string; name: string; archived: boolean; repos: Array<{ id: string; gitRemote: string }> }>;
  members: Array<{ id: string; githubLogin: string }>;
}> {
  return withOrg(orgId, async (tx) => {
    const [org] = await tx.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    const ps = await tx.select().from(projects).where(eq(projects.orgId, orgId));
    const rs = await tx.select().from(repos).where(eq(repos.orgId, orgId));
    const ms = await tx.select().from(members).where(eq(members.orgId, orgId));
    // #2: a walled project only appears to its active project members; shared projects (default) to all.
    const myProjectIds = viewerMemberId
      ? new Set(
          (
            await tx
              .select({ projectId: projectMembers.projectId })
              .from(projectMembers)
              .where(and(eq(projectMembers.memberId, viewerMemberId), eq(projectMembers.status, "active")))
          ).map((r) => r.projectId),
        )
      : new Set<string>();
    const visible = ps.filter((p) => projectVisibility(p.settings) === "shared" || myProjectIds.has(p.id));
    return {
      org: org ?? null,
      // Include each project's connected repos so the CLI can resolve which project a repo belongs
      // to by its git remote (e.g. for `lockstep invite`) instead of guessing from the remote name.
      // Archived projects stay in the payload, flagged — the web renders them in a collapsed
      // section (so unarchive stays reachable); the CLI ignores them (connect is blocked anyway).
      projects: visible.map((p) => ({
        id: p.id,
        name: p.name,
        archived: projectArchived(p.settings),
        repos: rs.filter((r) => r.projectId === p.id).map((r) => ({ id: r.id, gitRemote: r.gitRemote })),
      })),
      members: ms.map((m) => ({ id: m.id, githubLogin: m.githubLogin })),
    };
  });
}

export async function projectOverview(orgId: string, projectId: string, viewerMemberId?: string) {
  return withOrg(orgId, async (tx) => {
    // Member ids resolve to logins server-side, once — the web never joins.
    const orgMembers = await tx.select().from(members).where(eq(members.orgId, orgId));
    const loginById = new Map(orgMembers.map((m) => [m.id, m.githubLogin]));
    const who = (v: string | null | undefined): string | null => (v ? (loginById.get(v) ?? v) : null);

    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    // Reverse lineage map (Phase J): "X supersedes Y" is Y.supersededById === X.
    const supersedesBy = new Map<string, string[]>();
    for (const d of ds) {
      if (!d.supersededById) continue;
      supersedesBy.set(d.supersededById, [...(supersedesBy.get(d.supersededById) ?? []), d.id]);
    }
    const now = new Date();
    const decisionList = [];
    const ruleTextById = new Map<string, string>();
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
        origin: d.origin,
        version: d.currentVersion,
        ruleText: v?.ruleText ?? "",
        decisionType: d.decisionType,
        // Phase J deliberation + lifecycle fields (the decisions page + Review-due tab read these).
        rationale: v?.rationale ?? null,
        alternatives: (v?.alternatives as string[] | null) ?? null,
        reviewAt: d.reviewAt,
        dueForReview: d.status === "binding" && d.reviewAt != null && d.reviewAt < now,
        supersededById: d.supersededById,
        supersedes: supersedesBy.get(d.id) ?? [],
        impact: d.impact,
        createdAt: d.createdAt,
        proposedBy: who(v?.proposedBy),
      });
      ruleTextById.set(d.id, v?.ruleText ?? "");
    }
    const qRows = await tx.select().from(questions).where(eq(questions.projectId, projectId));
    const answerRows = qRows.length
      ? await tx
          .select()
          .from(answers)
          .where(
            inArray(
              answers.questionId,
              qRows.map((q) => q.id),
            ),
          )
          .orderBy(desc(answers.createdAt))
      : [];
    const latestAnswer = new Map<string, (typeof answerRows)[number]>();
    for (const a of answerRows) if (!latestAnswer.has(a.questionId)) latestAnswer.set(a.questionId, a);
    const qs = qRows.map((q) => {
      const a = latestAnswer.get(q.id);
      return {
        id: q.id,
        body: q.body,
        status: q.status,
        scopeRef: q.scopeRef,
        urgent: q.urgent,
        askedBy: who(q.askedBy),
        createdAt: q.createdAt,
        answer: a ? { body: a.body, by: who(a.answeredBy), at: a.createdAt } : null,
      };
    });
    const tks = (await tx.select().from(tasks).where(eq(tasks.projectId, projectId))).map((t) => ({
      id: t.id,
      title: t.title,
      runState: t.runState,
      status: t.status,
      delegatedTo: who(t.delegatedTo),
      delegatedBy: who(t.delegatedBy),
      createdAt: t.createdAt,
    }));
    const rps = (await tx.select().from(repos).where(eq(repos.projectId, projectId))).map((r) => ({
      id: r.id,
      gitRemote: r.gitRemote,
    }));
    const repoIds = rps.map((r) => r.id);
    // #4: producer repos may live in other projects — resolve names org-wide, shared projects only.
    const orgRepos = await tx.select().from(repos);
    const repoById = new Map(orgRepos.map((r) => [r.id, r]));
    const projById = new Map(
      (await tx.select().from(projects))
        .filter((p) => projectVisibility(p.settings) === "shared")
        .map((p) => [p.id, p]),
    );
    const deps = (
      await tx
        .select()
        .from(dependencyEdges)
        .where(and(eq(dependencyEdges.projectId, projectId), eq(dependencyEdges.active, true)))
    ).map((d) => {
      // #4: a producer repo outside this project gets its (shared) project named for the UI badge.
      const producerRepo = d.producedRepoId ? repoById.get(d.producedRepoId) : undefined;
      const producerProj =
        producerRepo && producerRepo.projectId !== projectId ? projById.get(producerRepo.projectId) : undefined;
      return {
        id: d.id,
        consumerRepoId: d.consumerRepoId,
        producedRepoId: d.producedRepoId,
        producedSurface: d.producedSurface,
        source: d.source,
        producerProject: producerProj ? { id: producerProj.id, name: producerProj.name } : null,
      };
    });
    const contractRows = repoIds.length
      ? (await tx.select().from(contracts).where(inArray(contracts.repoId, repoIds))).map((c) => ({
          id: c.id,
          repoId: c.repoId,
          surface: c.surface,
          verified: c.verified,
          verifiedAgainst: c.verifiedAgainst,
          verificationStatus: c.verificationStatus,
          version: c.version,
          consumerCount: deps.filter((e) => e.producedSurface === c.surface).length,
        }))
      : [];
    const changes = (
      await tx
        .select()
        .from(changeFeedEntries)
        .where(eq(changeFeedEntries.projectId, projectId))
        .orderBy(desc(changeFeedEntries.createdAt))
        .limit(20)
    ).map((c) => ({
      id: c.id,
      surface: c.surface,
      summary: c.summary,
      riskTier: c.riskTier,
      impact: c.impact,
      createdBy: who(c.createdBy),
      createdAt: c.createdAt,
      repoId: c.repoId,
    }));
    // Audit rows carry actor + entity so the feed can say "who did what to which thing".
    const summaryFor = (kind: string | null, id: string | null): string | null => {
      if (!id) return null;
      if (kind === "decision") return ruleTextById.get(id) ?? null;
      if (kind === "question") return qs.find((q) => q.id === id)?.body ?? null;
      if (kind === "task") return tks.find((t) => t.id === id)?.title ?? null;
      if (kind === "change_feed_entry") return changes.find((c) => c.id === id)?.summary ?? null;
      if (kind === "dependency_edge") return deps.find((d) => d.id === id)?.producedSurface ?? null;
      return null;
    };
    const audit = (
      await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.projectId, projectId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(50)
    ).map((a) => ({
      action: a.action,
      entityKind: a.entityKind,
      entityId: a.entityId,
      createdAt: a.createdAt,
      actor: a.actorMemberId ? (loginById.get(a.actorMemberId) ?? null) : null,
      summary: summaryFor(a.entityKind, a.entityId),
    }));
    // v3: project-scoped member roster with roles, and the viewer's own role — the dashboard gates
    // ratify/role-change ACTIONS on these (pages stay open to every member).
    const pms = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
    const slackById = new Map(orgMembers.map((m) => [m.id, m.slackUserId]));
    const memberList = pms.map((pm) => ({
      id: pm.id,
      memberId: pm.memberId,
      githubLogin: pm.invitedGithubLogin,
      role: pm.role,
      status: pm.status,
      slackUserId: pm.memberId ? (slackById.get(pm.memberId) ?? null) : null,
    }));
    const viewer = viewerMemberId
      ? {
          memberId: viewerMemberId,
          role: pms.find((pm) => pm.memberId === viewerMemberId && pm.status === "active")?.role ?? "member",
        }
      : undefined;
    const proj = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    return {
      decisions: decisionList,
      questions: qs,
      tasks: tks,
      repos: rps,
      dependencies: deps,
      contracts: contractRows,
      changes,
      audit,
      members: memberList,
      viewer,
      visibility: proj ? projectVisibility(proj.settings) : "shared",
      archived: proj ? projectArchived(proj.settings) : false,
      productLayer: Boolean((proj?.settings as { productLayer?: { enabled?: boolean } } | null)?.productLayer?.enabled),
      autoBind: Boolean((proj?.settings as { autoBind?: { enabled?: boolean } } | null)?.autoBind?.enabled),
    };
  });
}

/**
 * Everything the Decision detail page shows: current text + rationale, every version, who acked,
 * who still must, provenance quotes, the consumers that make up its blast radius, lineage with
 * rule texts (never bare ids), and conflicts that reference it. Null when not in this project.
 */
export async function decisionDetail(orgId: string, projectId: string, id: string) {
  return withOrg(orgId, async (tx) => {
    const d = (
      await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.id, id), eq(decisions.projectId, projectId)))
        .limit(1)
    )[0];
    if (!d) return null;
    const orgMembers = await tx.select().from(members).where(eq(members.orgId, orgId));
    const loginById = new Map(orgMembers.map((m) => [m.id, m.githubLogin]));
    const login = (mid: string | null | undefined): string | null => (mid ? (loginById.get(mid) ?? null) : null);

    const versions = (
      await tx.select().from(decisionVersions).where(eq(decisionVersions.decisionId, id)).orderBy(desc(decisionVersions.version))
    ).map((v) => ({
      version: v.version,
      baseVersion: v.baseVersion,
      ruleText: v.ruleText,
      rationale: v.rationale,
      alternatives: (v.alternatives as string[] | null) ?? null,
      status: v.status,
      proposedBy: login(v.proposedBy),
      createdAt: v.createdAt,
    }));
    const current = versions.find((v) => v.version === d.currentVersion) ?? versions[0];

    const approvals = (
      await tx.select().from(decisionApprovals).where(eq(decisionApprovals.decisionId, id)).orderBy(desc(decisionApprovals.createdAt))
    ).map((a) => ({
      version: a.version,
      reviewer: login(a.reviewerId),
      verdict: a.verdict,
      comment: a.comment,
      createdAt: a.createdAt,
    }));
    const requiredReviewers = (
      await tx.select().from(decisionRequiredReviewers).where(eq(decisionRequiredReviewers.decisionId, id))
    ).map((r) => ({ reviewer: login(r.reviewerMemberId), required: r.required }));
    const provenances = (await tx.select().from(decisionProvenances).where(eq(decisionProvenances.decisionId, id))).map(
      (p) => ({
        source: p.source,
        url: p.url,
        evidence: (p.evidence as Array<{ quote: string }> | null) ?? null,
        confidence: confidenceFraction(p.confidence),
      }),
    );

    // Blast radius: active dependency edges on the scope surface (topic/capability scopes have none).
    const repoRows = await tx.select().from(repos);
    const projRows = await tx.select().from(projects);
    const consumers =
      d.scopeKind === "surface"
        ? (
            await tx
              .select()
              .from(dependencyEdges)
              .where(and(eq(dependencyEdges.producedSurface, d.scopeRef), eq(dependencyEdges.active, true)))
          ).map((e) => {
            const r = repoRows.find((x) => x.id === e.consumerRepoId);
            const p = r ? projRows.find((x) => x.id === r.projectId) : undefined;
            return {
              repoId: e.consumerRepoId,
              gitRemote: r?.gitRemote ?? null,
              project: p && p.id !== projectId ? { id: p.id, name: p.name } : null,
              source: e.source,
            };
          })
        : [];
    const sameSurfaceBinding =
      d.scopeKind === "surface"
        ? (
            await tx
              .select({ id: decisions.id })
              .from(decisions)
              .where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, d.scopeRef), eq(decisions.status, "binding")))
          ).filter((x) => x.id !== id).length
        : 0;

    const textOf = async (did: string | null) => {
      if (!did) return null;
      const x = (await tx.select().from(decisions).where(eq(decisions.id, did)).limit(1))[0];
      if (!x) return null;
      const v = (
        await tx
          .select({ ruleText: decisionVersions.ruleText })
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, did), eq(decisionVersions.version, x.currentVersion)))
          .limit(1)
      )[0];
      return { id: did, ruleText: v?.ruleText ?? "", status: x.status };
    };
    const supersededBy = await textOf(d.supersededById);
    const supersedes: Array<{ id: string; ruleText: string; status: string }> = [];
    for (const x of await tx
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.projectId, projectId), eq(decisions.supersededById, id)))) {
      const t = await textOf(x.id);
      if (t) supersedes.push(t);
    }
    const conflictRows = (await tx.select().from(conflicts).where(eq(conflicts.projectId, projectId))).filter(
      (c) => c.constraintDecisionId === id || c.engDecisionId === id,
    );

    return {
      id: d.id,
      projectId: d.projectId,
      scopeKind: d.scopeKind,
      scopeRef: d.scopeRef,
      decisionType: d.decisionType,
      status: d.status,
      origin: d.origin,
      impact: d.impact,
      currentVersion: d.currentVersion,
      constraintKind: d.constraintKind,
      expiresAt: d.expiresAt,
      reviewAt: d.reviewAt,
      createdAt: d.createdAt,
      ruleText: current?.ruleText ?? "",
      rationale: current?.rationale ?? null,
      alternatives: current?.alternatives ?? null,
      proposedBy: current?.proposedBy ?? null,
      versions,
      approvals,
      requiredReviewers,
      provenances,
      consumers,
      sameSurfaceBinding,
      lineage: { supersedes, supersededBy },
      conflicts: conflictRows.map((c) => ({ id: c.id, kind: c.kind, status: c.status, surface: c.surface })),
    };
  });
}
