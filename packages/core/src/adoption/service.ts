import { sessionStandards } from "../standards/briefing.js";
import { createHash } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { auditEvents, briefingCursors, sessions, usageEvents, decisionChecks, checkFeedback, repos, projects, sourceDocuments, contracts, dependencyEdges, changeFeedEntries } from "../db/schema.js";
import type { SessionContext } from "../api/session-context.js";
import { fileProposedDecision, listDecisions, constraintsInScope } from "../ledger/ledger-service.js";
import { extractRules, type Extractor, type Section } from "./providers.js";
import { renderDecisionPack } from "../ledger/decision-pack.js";

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const fail = (message: string, statusCode = 400): Error => Object.assign(new Error(message), { statusCode });

export async function usage(c: Pick<SessionContext, "orgId" | "projectId" | "memberId"> & Partial<SessionContext>, event: string, eventKey: string, counts: Record<string, number> = {}) {
  await withOrg(c.orgId, (tx) => tx.insert(usageEvents).values({
    orgId: c.orgId, projectId: c.projectId, memberId: c.memberId, repoId: c.repoId,
    sessionId: c.sessionId, event, eventKey, counts,
  }).onConflictDoNothing());
}

export async function sessionRepo(c: SessionContext) {
  const r = await withOrg(c.orgId, async (tx) => (await tx.select().from(repos).where(and(eq(repos.id, c.repoId), eq(repos.projectId, c.projectId))).limit(1))[0]);
  if (!r) throw fail("repo no longer connected", 409);
  return r;
}

export async function distillRepo(c: SessionContext, files: Array<{ path: string; sections: Section[] }>, commit: string, extractor: Extractor = extractRules) {
  const repo = await sessionRepo(c);
  const sections = files.flatMap((f) => f.sections.map((s) => ({ ...s, anchorKey: `${f.path}#${s.anchorKey}` })));
  const extracted = await extractor(sections, "repo");
  if (extracted === null) return { proposals: [], status: "unavailable", degraded: false, orgId: c.orgId, projectId: c.projectId };
  const { rules, degraded } = extracted;
  const proposals = [];
  for (const rule of rules) {
    const source = sections.find((s) => s.anchorKey === rule.anchorKey);
    if (!source || !source.text.includes(rule.evidence)) continue;
    const result = await fileProposedDecision(c.orgId, {
      projectId: c.projectId, scopeKind: "repo", scopeRef: repo.gitRemote,
      ruleText: rule.ruleText, decisionType: rule.decisionType, rationale: rule.rationale,
      explicitReview: true, connectionId: repo.id,
      externalId: `repo:${rule.anchorKey}:${digest(rule.evidence).slice(0, 16)}`,
      contentHash: digest(source.text), confidence: Math.round(rule.confidence * 100),
      provenance: { source: "repo_doc", path: rule.anchorKey.split("#")[0], headingPath: source.headingPath, commit, evidence: [{ quote: rule.evidence }], importedBy: c.memberId },
    });
    proposals.push({ ...result, ruleText: rule.ruleText, decisionType: rule.decisionType, anchorKey: rule.anchorKey, evidence: rule.evidence });
  }
  await usage(c, "repo_imported", digest({ files, commit }), { proposals: proposals.length });
  return { proposals, status: "completed", degraded, orgId: c.orgId, projectId: c.projectId };
}

export async function scopedRules(c: SessionContext, surfaces: string[], featureRef?: string) {
  const repo = await sessionRepo(c);
  const [all, mapped, activeDocs, project] = await Promise.all([
    listDecisions(c.orgId, c.projectId), constraintsInScope(c.orgId, c.projectId, c.repoId),
    withOrg(c.orgId, (tx) => tx.select().from(sourceDocuments).where(and(eq(sourceDocuments.projectId, c.projectId), eq(sourceDocuments.state, "active")))),
    withOrg(c.orgId, async (tx) => (await tx.select().from(projects).where(eq(projects.id, c.projectId)).limit(1))[0]),
  ]);
  const productOn = Boolean((project?.settings as { productLayer?: { enabled?: boolean } })?.productLayer?.enabled);
  const mappedIds = new Set(mapped.map((d) => d.id));
  return all.filter((d) => {
    if (d.status !== "binding") return false;
    if (d.origin === "document") {
      if (!productOn) return false;
      const docId = (d.provenance as { documentId?: string } | null)?.documentId;
      if (!activeDocs.some((doc) => doc.id === docId)) return false;
      return mappedIds.has(d.id) || (d.scopeKind === "capability" && !!featureRef && d.scopeRef === featureRef) || (d.scopeKind === "surface" && surfaces.includes(d.scopeRef));
    }
    return d.scopeKind === "project" || (d.decisionType === "principle" && d.scopeKind !== "repo") ||
      (d.scopeKind === "repo" && d.scopeRef === repo.gitRemote) ||
      ((d.scopeKind === "surface" || d.scopeKind === "contract") && surfaces.includes(d.scopeRef));
  }).sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id));
}

/**
 * The surfaces this session's repo is answerable for: what it serves, plus what it has declared it
 * calls. Without these, `scopedRules` can never match a surface- or contract-scoped decision, so the
 * briefing and the pack silently omit exactly the rules an agent is about to break.
 */
export async function repoSurfaces(c: SessionContext): Promise<string[]> {
  return withOrg(c.orgId, async (tx) => {
    const produced = await tx.select({ s: contracts.surface }).from(contracts).where(eq(contracts.repoId, c.repoId));
    const consumed = await tx
      .select({ s: dependencyEdges.producedSurface })
      .from(dependencyEdges)
      .where(and(eq(dependencyEdges.consumerRepoId, c.repoId), eq(dependencyEdges.active, true)));
    // Surfaces this repo has actually CHANGED. A contracts row only appears when a contract delta is
    // published or `scan --apply` runs, and the capture hook sends neither — so an agent that called
    // propose_decision on a surface it had just edited never saw that rule again in its own pack.
    // The change feed is repo-scoped and always written, so it closes that hole without a CLI change.
    const touched = await tx
      .select({ s: changeFeedEntries.surface })
      .from(changeFeedEntries)
      .where(eq(changeFeedEntries.repoId, c.repoId));
    return [...new Set([...produced, ...consumed, ...touched].map((r) => r.s).filter((v): v is string => !!v))];
  });
}

export async function continuityPack(c: SessionContext, featureRef?: string, surfaces?: string[]) {
  const rules = await scopedRules(c, surfaces ?? (await repoSurfaces(c)), featureRef);
  const p = await withOrg(c.orgId, async (tx) => (await tx.select().from(projects).where(eq(projects.id, c.projectId)).limit(1))[0]);
  const rendered = renderDecisionPack({ projectName: p?.name ?? "Project", decisions: rules });
  const generatedAt = new Date().toISOString();
  return { ...rendered, generatedAt, markdown: `---\nname: lockstep-decisions\ndescription: Accepted decisions for this repo and selected feature. Refresh when context changes.\n---\n<!-- lockstep-pack hash=${rendered.packHash} generated=${generatedAt} -->\n\n${rendered.body}` };
}

/** Read-only summary first. A separate receipt advances the cursor only after the hook delivered it. */
export async function continuity(c: SessionContext, featureRef?: string) {
  const sess = await withOrg(c.orgId, async (tx) => (await tx.select().from(sessions).where(eq(sessions.id, c.sessionId)).limit(1))[0]);
  const surfaces = await repoSurfaces(c);
  const rules = await scopedRules(c, surfaces, featureRef);
  const baseline = sess?.briefingBaseline ?? new Date(0);
  const until = sess?.startedAt ?? new Date();
  const [events, checks, feedback] = await Promise.all([
    withOrg(c.orgId, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.projectId, c.projectId), gt(auditEvents.createdAt, baseline), lte(auditEvents.createdAt, until))).orderBy(desc(auditEvents.createdAt)).limit(100)),
    withOrg(c.orgId, (tx) => tx.select().from(decisionChecks).where(and(eq(decisionChecks.projectId, c.projectId), eq(decisionChecks.repoId, c.repoId))).orderBy(desc(decisionChecks.createdAt)).limit(10)),
    withOrg(c.orgId, (tx) => tx.select().from(checkFeedback).where(eq(checkFeedback.projectId, c.projectId))),
  ]);
  const ids = new Set(rules.map((r) => r.id));
  // Include supersessions on this repo even though the old decision is no longer in binding rules.
  const repo = await sessionRepo(c);
  const history = await listDecisions(c.orgId, c.projectId);
  for (const d of history) if (d.scopeKind === "repo" && d.scopeRef === repo.gitRemote) ids.add(d.id);
  return {
    packHash: (await continuityPack(c, featureRef, surfaces)).packHash,
    since: sess?.briefingBaseline?.toISOString() ?? null,
    decisions: rules.slice(0, 30).map((d) => ({ id: d.id, version: d.version, ruleText: d.ruleText, scopeRef: d.scopeRef })),
    overflow: Math.max(0, rules.length - 30),
    updates: events.filter((e) => e.entityId && ids.has(e.entityId) && /decision\.|constraint\./.test(e.action)).slice(0, 12).map((e) => ({ id: e.id, decisionId: e.entityId, action: e.action, at: e.createdAt })),
    concerns: checks.flatMap((check) => (check.findings as Array<{ decisionId: string; version: number; file: string; line: number }>).filter((f) => rules.some((r) => r.id === f.decisionId && r.version === f.version) && !feedback.some((fb) => fb.checkId === check.id && fb.decisionId === f.decisionId && fb.verdict !== "useful")).map((f) => ({ ...f, checkId: check.id }))).slice(0, 8),
    nativeSession: Boolean(sess?.nativeSessionId),
    standards: await sessionStandards(c).catch(() => null),
  };
}

export async function acknowledgeBriefing(c: SessionContext, decisionIds: string[]) {
  await withOrg(c.orgId, async (tx) => {
    const s = (await tx.select().from(sessions).where(eq(sessions.id, c.sessionId)).limit(1))[0];
    if (!s?.nativeSessionId) return; // CLI setup cannot activate an agent.
    await tx.insert(briefingCursors).values({ orgId: c.orgId, memberId: c.memberId, repoId: c.repoId, seenAt: s.startedAt }).onConflictDoUpdate({
      target: [briefingCursors.memberId, briefingCursors.repoId], set: { seenAt: sql`greatest(${briefingCursors.seenAt}, ${s.startedAt.toISOString()}::timestamptz)` },
    });
    await tx.insert(usageEvents).values({ orgId: c.orgId, projectId: c.projectId, memberId: c.memberId, repoId: c.repoId, sessionId: c.sessionId, event: "agent_briefing_delivered", eventKey: c.sessionId, counts: { decisions: decisionIds.length } }).onConflictDoNothing();
  });
  return { ok: true };
}
