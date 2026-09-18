import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { resolveSession, type SessionContext } from "../api/session-context.js";
import { ensureMember, ensureProjectVisible, requireProductLayer } from "../api/guards.js";
import { canManageDocTx, getProjectRoleTx, projectArchived } from "../auth/permissions.js";
import { withOrg } from "../db/rls.js";
import { checkFeedback, decisionChecks, projects, sourceDocuments, usageEvents } from "../db/schema.js";
import { confirmDecision, rejectDecision, ratifyDecision, fileProposedDecision, listDecisions } from "../ledger/ledger-service.js";
import { acknowledgeBriefing, continuity, continuityPack, digest, distillRepo, fail, sessionRepo, usage } from "./service.js";
import { runCheck } from "./checks.js";
import { createPilotProject } from "./projects.js";
import { nativeHistory, saveNativeBrief } from "./native-documents.js";
import { buildBrief } from "./sharing.js";
import { extractRules, systemOne, type Extractor, type Judge } from "./providers.js";
import { modelBudget } from "./limits.js";

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}
async function session(req: FastifyRequest, reply: FastifyReply): Promise<SessionContext | null> {
  const id = req.headers["x-lockstep-session"];
  if (!req.principal) { reply.code(401).send({ error: "unauthorized" }); return null; }
  if (typeof id !== "string" || !z.string().uuid().safeParse(id).success) { reply.code(400).send({ error: "valid x-lockstep-session required" }); return null; }
  const c = await resolveSession(req.principal, id);
  if (!c) reply.code(403).send({ error: "session access revoked or invalid" });
  return c;
}
const projectParams = z.object({ orgId: z.string().uuid(), projectId: z.string().uuid() });
async function projectContext(req: FastifyRequest, reply: FastifyReply, write = false) {
  const { orgId, projectId } = parse(projectParams, req.params);
  const memberId = await ensureMember(req, reply, orgId);
  if (!memberId || !(await ensureProjectVisible(reply, orgId, projectId, memberId))) return null;
  const result = await withOrg(orgId, async (tx) => {
    const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    const role = await getProjectRoleTx(tx, projectId, memberId);
    if (!p || (write && (projectArchived(p.settings) || !role))) throw fail("project unavailable or write access not granted", 403);
    return { role, p };
  });
  return { orgId, projectId, memberId, ...result };
}

/** Dependency injection is only construction-time, never a user-controlled provider override. */
export function adoptionRoutesWith(providers: { extractor?: Extractor; judge?: Judge } = {}) {
  return async function adoptionRoutes(app: FastifyInstance) {
    const extractor = providers.extractor ?? extractRules;
    const judge = providers.judge ?? systemOne;
    const bounded = modelBudget();
    app.post("/pilot/projects", async (req, reply) => {
      if (!req.principal) return reply.code(401).send({ error: "unauthorized" });
      const b = parse(z.object({ name: z.string().trim().min(1).max(120), orgId: z.string().uuid().optional() }), req.body);
      return createPilotProject(req.principal, b.name, b.orgId);
    });
    app.post("/repo/distill", async (req, reply) => {
      const c = await session(req, reply); if (!c) return;
      const b = parse(z.object({ commit: z.string().max(100), files: z.array(z.object({
        path: z.string().min(1).max(500).refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && /\.md$/i.test(p)),
        sections: z.array(z.object({ anchorKey: z.string().min(1).max(600), headingPath: z.array(z.string().max(200)).max(12), text: z.string().min(1).refine((t) => Buffer.byteLength(t) <= 4000) })).max(60),
      })).max(40).refine((fs) => fs.reduce((n, f) => n + f.sections.length, 0) <= 60) }), req.body);
      return bounded(c.memberId, () => distillRepo(c, b.files, b.commit, extractor));
    });
    app.post("/repo/decisions", async (req, reply) => {
      const c = await session(req, reply); if (!c) return;
      const b = parse(z.object({ ruleText: z.string().trim().min(1).max(4000), rationale: z.string().max(2000).optional() }), req.body);
      const repo = await sessionRepo(c);
      const result = await fileProposedDecision(c.orgId, { projectId: c.projectId, scopeKind: "repo", scopeRef: repo.gitRemote, ruleText: b.ruleText, rationale: b.rationale, explicitReview: true, connectionId: c.repoId, externalId: `manual:${digest(b.ruleText)}`, contentHash: digest(b), confidence: 100, provenance: { source: "repo_manual", importedBy: c.memberId } });
      return { ...result, orgId: c.orgId, projectId: c.projectId };
    });
    app.get("/continuity", async (req, reply) => {
      const c = await session(req, reply); if (!c) return;
      const b = parse(z.object({ featureRef: z.string().max(200).optional() }), req.query);
      return continuity(c, b.featureRef);
    });
    app.get("/continuity/pack", async (req, reply) => {
      const c = await session(req, reply); if (!c) return;
      const b = parse(z.object({ featureRef: z.string().max(200).optional() }), req.query);
      return continuityPack(c, b.featureRef);
    });
    app.post("/continuity/receipt", async (req, reply) => {
      const c = await session(req, reply); if (!c) return;
      const b = parse(z.object({ decisionIds: z.array(z.string().uuid()).max(30) }), req.body);
      const all = await listDecisions(c.orgId, c.projectId);
      if (b.decisionIds.some((id) => !all.some((d) => d.id === id && d.status === "binding"))) throw fail("receipt includes an unavailable decision");
      return acknowledgeBriefing(c, b.decisionIds);
    });
    app.post("/checks", async (req, reply) => {
      const c = await session(req, reply); if (!c) return;
      const b = parse(z.object({
        hunks: z.array(z.object({ file: z.string().min(1).max(500), text: z.string().max(200_000) })).max(200),
        surfaces: z.array(z.string().max(300)).max(100), featureRef: z.string().max(200).optional(),
        partial: z.boolean().optional(), base: z.string().max(200).optional(),
      }), req.body);
      return bounded(c.memberId, () => runCheck(c, b, judge));
    });

    const root = "/orgs/:orgId/projects/:projectId";
    app.post(`${root}/native-documents`, async (req, reply) => {
      const c = await projectContext(req, reply, true); if (!c) return;
      if (!(await requireProductLayer(reply, c.orgId, c.projectId))) return;
      const b = parse(z.object({ documentId: z.string().uuid().optional(), baseVersion: z.number().int().positive().optional(), title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).refine((v) => Buffer.byteLength(v) <= 200_000), featureRef: z.string().regex(/^feature:[a-z0-9][a-z0-9-]*$/).max(200).optional(), manualRules: z.array(z.string().min(1).max(4000)).max(20).optional() }), req.body);
      if (b.manualRules?.some((r) => !b.content.includes(r))) throw fail("manual requirements must quote the pasted source");
      return b.manualRules?.length ? saveNativeBrief(c.orgId, c.projectId, c.memberId, b, extractor) : bounded(c.memberId, () => saveNativeBrief(c.orgId, c.projectId, c.memberId, b, extractor));
    });
    app.get(`${root}/native-documents/:documentId`, async (req, reply) => {
      const c = await projectContext(req, reply); if (!c) return;
      const { documentId } = parse(z.object({ documentId: z.string().uuid() }), req.params);
      return nativeHistory(c.orgId, c.projectId, documentId);
    });
    app.post(`${root}/review/:decisionId`, async (req, reply) => {
      const c = await projectContext(req, reply, true); if (!c) return;
      const { decisionId } = parse(z.object({ decisionId: z.string().uuid() }), req.params);
      const b = parse(z.object({ action: z.enum(["confirm", "reject", "ratify"]), ruleText: z.string().trim().min(1).max(4000).optional(), supersedesDecisionId: z.string().uuid().optional() }), req.body);
      const d = (await listDecisions(c.orgId, c.projectId)).find((d) => d.id === decisionId);
      if (!d) throw fail("decision not found", 404);
      const prov = d.provenance as { importedBy?: string; documentId?: string } | null;
      let canReview = c.role === "owner" || c.role === "pm" || prov?.importedBy === c.memberId;
      if (d.origin === "document" && prov?.documentId) canReview = await withOrg(c.orgId, async (tx) => {
        const doc = (await tx.select().from(sourceDocuments).where(and(eq(sourceDocuments.id, prov.documentId!), eq(sourceDocuments.projectId, c.projectId))).limit(1))[0];
        return !!doc && canManageDocTx(tx, { projectId: c.projectId, memberId: c.memberId, doc });
      });
      if (!canReview) throw fail("only the proposal author, PM or owner can review", 403);
      if (b.action === "confirm" && d.origin === "document") throw fail("product requirements must be ratified");
      const result = b.action === "reject" ? await rejectDecision(c.orgId, decisionId, c.memberId) : b.action === "ratify" ? await ratifyDecision(c.orgId, decisionId, c.memberId, { ruleText: b.ruleText }) : await confirmDecision(c.orgId, decisionId, c.memberId, { ruleText: b.ruleText, supersedesDecisionId: b.supersedesDecisionId });
      await usage(c, `decision_${b.action}`, `${decisionId}:${d.version}`);
      return result;
    });
    app.get(`${root}/checks`, async (req, reply) => {
      const c = await projectContext(req, reply); if (!c) return;
      const { decisionId, featureRef } = parse(z.object({ decisionId: z.string().uuid().optional(), featureRef: z.string().max(200).optional() }), req.query);
      const checks = await withOrg(c.orgId, (tx) => tx.select().from(decisionChecks).where(and(eq(decisionChecks.projectId, c.projectId), featureRef ? eq(decisionChecks.featureRef, featureRef) : undefined)).orderBy(desc(decisionChecks.createdAt)).limit(30));
      const feedback = await withOrg(c.orgId, (tx) => tx.select().from(checkFeedback).where(eq(checkFeedback.projectId, c.projectId)));
      return { checks: decisionId ? checks.filter((check) => (check.ruleVersions as Array<{ id: string }>).some((r) => r.id === decisionId)) : checks, feedback };
    });
    app.post(`${root}/checks/:checkId/feedback`, async (req, reply) => {
      const c = await projectContext(req, reply, true); if (!c) return;
      const { checkId } = parse(z.object({ checkId: z.string().uuid() }), req.params);
      const b = parse(z.object({ decisionId: z.string().uuid(), verdict: z.enum(["useful", "false_positive", "intentional_exception"]) }), req.body);
      await withOrg(c.orgId, async (tx) => {
        const check = (await tx.select().from(decisionChecks).where(and(eq(decisionChecks.projectId, c.projectId), eq(decisionChecks.id, checkId))).limit(1))[0];
        if (!check || !(check.findings as Array<{ decisionId: string }>).some((f) => f.decisionId === b.decisionId)) throw fail("finding not found", 404);
        await tx.insert(checkFeedback).values({ orgId: c.orgId, projectId: c.projectId, memberId: c.memberId, checkId, ...b }).onConflictDoUpdate({ target: [checkFeedback.checkId, checkFeedback.decisionId, checkFeedback.memberId], set: { verdict: b.verdict } });
      });
      await usage(c, `feedback_${b.verdict}`, `${checkId}:${b.decisionId}`);
      return { ok: true };
    });
    app.get(`${root}/brief`, async (req, reply) => {
      const c = await projectContext(req, reply); if (!c) return;
      const filters = parse(z.object({ decisionId: z.string().uuid().optional(), documentId: z.string().uuid().optional(), featureRef: z.string().max(200).optional() }), req.query);
      return buildBrief(c, filters);
    });
    app.post(`${root}/brief/exported`, async (req, reply) => {
      const c = await projectContext(req, reply); if (!c) return;
      const b = parse(z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), filters: z.object({ decisionId: z.string().uuid().optional(), documentId: z.string().uuid().optional(), featureRef: z.string().max(200).optional() }).default({}) }), req.body);
      const brief = await buildBrief(c, b.filters);
      if (brief.hash !== b.hash) throw fail("brief changed; preview the current version before recording export", 409);
      await usage(c, "brief_exported", `${b.hash}:${new Date().toISOString().slice(0, 10)}`, { accepted: brief.accepted, ratifiedRequirements: brief.ratifiedRequirements, implementation: b.filters.documentId || b.filters.featureRef ? 1 : 0 });
      return { ok: true };
    });
    app.get(`${root}/adoption`, async (req, reply) => {
      const c = await projectContext(req, reply); if (!c) return;
      const events = await withOrg(c.orgId, (tx) => tx.select().from(usageEvents).where(eq(usageEvents.projectId, c.projectId)).orderBy(desc(usageEvents.createdAt)).limit(500));
      return { pilot: Boolean((c.p.settings as { adoption?: { pilot?: boolean } })?.adoption?.pilot), events };
    });
  };
}
export const adoptionRoutes = adoptionRoutesWith();
