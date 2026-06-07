import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSession, type SessionContext } from "../session-context.js";
import {
  proposeDecision,
  ackDecision,
  listDecisions,
  registerDependency,
  recordChange,
  queryLedger,
  askQuestion,
  answerQuestion,
  createTask,
  completeTask,
  reconcile,
} from "../../ledger/ledger-service.js";
import { whoowns, refreshOwnership } from "../../graph/ownership-service.js";
import { readInbox } from "../../inbox/inbox-service.js";

/** Resolve the session context from the x-lockstep-session header (set by the MCP server). */
async function ctx(req: FastifyRequest, reply: FastifyReply): Promise<SessionContext | null> {
  const p = req.principal;
  if (!p) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const sid = req.headers["x-lockstep-session"];
  if (!sid || typeof sid !== "string") {
    reply.code(400).send({ error: "x-lockstep-session header required" });
    return null;
  }
  const c = await resolveSession(p, sid);
  if (!c) {
    reply.code(403).send({ error: "invalid session" });
    return null;
  }
  return c;
}

export async function ledgerRoutes(app: FastifyInstance): Promise<void> {
  // notify(summary, contract_delta, scope, risk_tier)
  app.post("/changes", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as {
      summary?: string;
      surface?: string;
      contractDelta?: unknown;
      riskTier?: string;
      verified?: boolean;
      verifiedAgainst?: string;
      diffHash?: string;
    };
    if (!b?.summary) return reply.code(400).send({ error: "summary required" });
    return recordChange(c.orgId, {
      projectId: c.projectId,
      repoId: c.repoId,
      memberId: c.memberId,
      summary: b.summary,
      surface: b.surface,
      contractDelta: b.contractDelta,
      riskTier: b.riskTier,
      verified: b.verified,
      verifiedAgainst: b.verifiedAgainst,
      diffHash: b.diffHash,
    });
  });

  // propose_decision(rule, scope, base_version)
  app.post("/decisions", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { scopeKind?: string; scopeRef?: string; ruleText?: string; baseVersion?: number; provenance?: unknown };
    if (!b?.scopeKind || !b?.scopeRef || !b?.ruleText || b.baseVersion === undefined) {
      return reply.code(400).send({ error: "scopeKind, scopeRef, ruleText, baseVersion required" });
    }
    return proposeDecision(c.orgId, {
      projectId: c.projectId,
      memberId: c.memberId,
      scopeKind: b.scopeKind,
      scopeRef: b.scopeRef,
      ruleText: b.ruleText,
      baseVersion: b.baseVersion,
      provenance: b.provenance,
    });
  });

  // ack_decision(decision_id, version, verdict?)
  app.post("/decisions/:id/ack", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { id } = req.params as { id: string };
    const b = req.body as { version?: number; verdict?: string };
    if (b?.version === undefined) return reply.code(400).send({ error: "version required" });
    return ackDecision(c.orgId, id, b.version, c.memberId, b.verdict ?? "ack");
  });

  // decisions(scope)
  app.get("/decisions", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { scope } = req.query as { scope?: string };
    return { decisions: await listDecisions(c.orgId, c.projectId, scope) };
  });

  // register_dependency(consumer, produced_surface)
  app.post("/dependencies", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { producedSurface?: string; producedRepoId?: string; source?: string };
    if (!b?.producedSurface) return reply.code(400).send({ error: "producedSurface required" });
    return registerDependency(c.orgId, {
      projectId: c.projectId,
      memberId: c.memberId,
      consumerRepoId: c.repoId,
      producedSurface: b.producedSurface,
      producedRepoId: b.producedRepoId ?? null,
      source: b.source,
    });
  });

  // inbox()
  app.get("/inbox", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    return readInbox(c.orgId, { memberId: c.memberId, repoId: c.repoId, projectId: c.projectId });
  });

  // query(question, scope?)
  app.post("/query", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { question?: string };
    if (!b?.question) return reply.code(400).send({ error: "question required" });
    return queryLedger(c.orgId, c.projectId, b.question);
  });

  // whoowns(path)
  app.get("/owners", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path required" });
    return { owners: await whoowns(c.orgId, c.repoId, path) };
  });

  // ask(question, scope?, urgent?)
  app.post("/questions", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { question?: string; scope?: string; urgent?: boolean };
    if (!b?.question) return reply.code(400).send({ error: "question required" });
    return askQuestion(c.orgId, { projectId: c.projectId, memberId: c.memberId, body: b.question, scopeRef: b.scope, urgent: b.urgent });
  });

  // answer(question_id, response)
  app.post("/questions/:id/answer", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { id } = req.params as { id: string };
    const b = req.body as { response?: string };
    if (!b?.response) return reply.code(400).send({ error: "response required" });
    return answerQuestion(c.orgId, id, c.memberId, b.response);
  });

  // delegate(to, task, refs)
  app.post("/tasks", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { to?: string; task?: string; refs?: unknown };
    if (!b?.task) return reply.code(400).send({ error: "task required" });
    return createTask(c.orgId, { projectId: c.projectId, memberId: c.memberId, title: b.task, to: b.to, refs: b.refs });
  });

  // complete(task_id, note)
  app.post("/tasks/:id/complete", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { id } = req.params as { id: string };
    return completeTask(c.orgId, id, c.memberId);
  });

  // Tier-2 reconcile (PR check) — verify changed contract surfaces against the ledger
  app.post("/reconcile", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { contractSurfaces?: string[] };
    if (!Array.isArray(b?.contractSurfaces)) return reply.code(400).send({ error: "contractSurfaces[] required" });
    return reconcile(c.orgId, c.projectId, b.contractSurfaces);
  });

  // ingest CODEOWNERS (onboarding/dev; in prod the core fetches it via the GitHub App)
  app.post("/codeowners/refresh", async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const b = req.body as { content?: string; sha?: string };
    if (!b?.content) return reply.code(400).send({ error: "content required" });
    return refreshOwnership(c.orgId, c.repoId, b.content, b.sha ?? "manual");
  });
}
