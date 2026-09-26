import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ensureMember, ensureProjectVisible, requireProjectRole, workerAuthed } from "../guards.js";
import {
  ConceptError,
  createDomain,
  deleteDomain,
  mergeConcepts,
  placeItem,
  renameConcept,
  requestRebuild,
  setConceptDomain,
  setHttpRules,
  updateDomain,
} from "../../concepts/concept-service.js";
import {
  getConcept,
  getConceptContracts,
  getConceptDecisions,
  getConceptSettings,
  getConceptSources,
  getOutline,
  getOutlineDomain,
  getOutlineGroup,
  getSurfaceHistory,
} from "../../concepts/read.js";
import { drainConceptTasks } from "../../concepts/queue.js";
import { decisionBrief, decisionSummary } from "../../concepts/brief.js";
import { getGraph, getInbox, getLedger, searchProject, type InboxKind, type LedgerTab } from "../../concepts/views.js";

const INBOX_KINDS: InboxKind[] = [
  "conflict",
  "proposal",
  "ratification",
  "question",
  "task",
  "review_due",
  "placement",
  "check_finding",
  "exception_request",
  "rollout_failure",
];
const LEDGER_TABS: LedgerTab[] = ["decisions", "contracts", "sources", "questions", "tasks"];

const P = "/orgs/:orgId/projects/:projectId";
const EDITORS = ["owner", "pm"];

type Ctx = { orgId: string; projectId: string; memberId: string };

/** Member of the org + project visible (reads); `editors` additionally requires an editing role. */
async function ctx(req: FastifyRequest, reply: FastifyReply, editors = false): Promise<Ctx | null> {
  const { orgId, projectId } = req.params as { orgId: string; projectId: string };
  const memberId = await ensureMember(req, reply, orgId);
  if (!memberId) return null;
  if (!(await ensureProjectVisible(reply, orgId, projectId, memberId))) return null;
  if (editors && !(await requireProjectRole(reply, orgId, projectId, memberId, EDITORS))) return null;
  return { orgId, projectId, memberId };
}

async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConceptError) {
      reply.code(e.code).send({ error: e.message });
      return undefined;
    }
    throw e;
  }
}

const q = (req: FastifyRequest) => req.query as { cursor?: string };
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Concept ledger: bounded, paginated reads + field-scoped human edits + the worker drain. */
export async function conceptRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/concepts/drain", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return drainConceptTasks();
  });

  app.get(`${P}/outline`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    return getOutline(c.orgId, c.projectId, c.memberId);
  });

  app.get(`${P}/outline/domains/:domainId`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { domainId } = req.params as { domainId: string };
    return run(reply, () => getOutlineDomain(c.orgId, c.projectId, domainId, q(req).cursor));
  });

  app.get(`${P}/outline/groups/:group`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { group } = req.params as { group: string };
    return run(reply, () => getOutlineGroup(c.orgId, c.projectId, group, q(req).cursor));
  });

  app.get(`${P}/concepts/:conceptId`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { conceptId } = req.params as { conceptId: string };
    const { tab, cursor } = req.query as { tab?: string; cursor?: string };
    return run(reply, async () => {
      if (tab === "decisions") return getConceptDecisions(c.orgId, c.projectId, conceptId, cursor);
      if (tab === "contracts") return getConceptContracts(c.orgId, c.projectId, conceptId, cursor);
      if (tab === "sources") return getConceptSources(c.orgId, c.projectId, conceptId);
      return getConcept(c.orgId, c.projectId, conceptId);
    });
  });

  app.get(`${P}/surfaces/:surfaceId/history`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { surfaceId } = req.params as { surfaceId: string };
    return run(reply, () => getSurfaceHistory(c.orgId, c.projectId, surfaceId, q(req).cursor));
  });

  app.get(`${P}/concepts-settings`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    return getConceptSettings(c.orgId, c.projectId);
  });

  app.get(`${P}/inbox`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { cursor, kinds, housekeeping } = req.query as { cursor?: string; kinds?: string; housekeeping?: string };
    const ks = (kinds ?? "").split(",").filter((k): k is InboxKind => INBOX_KINDS.includes(k as InboxKind));
    return run(reply, () =>
      getInbox(c.orgId, c.projectId, c.memberId, {
        cursor,
        kinds: ks,
        housekeeping: housekeeping === "1" || ks.includes("placement") || ks.includes("rollout_failure"),
      }),
    );
  });

  app.get(`${P}/ledger/:tab`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { tab } = req.params as { tab: string };
    if (!LEDGER_TABS.includes(tab as LedgerTab)) return reply.code(404).send({ error: "unknown tab" });
    const qs = req.query as { cursor?: string; q?: string; status?: string; origin?: string; conceptId?: string };
    return run(reply, () => getLedger(c.orgId, c.projectId, tab as LedgerTab, qs));
  });

  app.get(`${P}/search`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { q } = req.query as { q?: string };
    return searchProject(c.orgId, c.projectId, q ?? "");
  });

  app.get(`${P}/graph/concepts`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { expand, cursor, focus } = req.query as { expand?: string; cursor?: string; focus?: string };
    return run(reply, () => getGraph(c.orgId, c.projectId, expand, cursor, focus));
  });

  app.get(`${P}/decisions/:decisionId/brief`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { decisionId } = req.params as { decisionId: string };
    const b = await decisionBrief(c.orgId, c.projectId, decisionId);
    if (!b) return reply.code(404).send({ error: "not_found" });
    return b;
  });

  // Generated lazily (the brief renders without it); cached per decision version.
  app.post(`${P}/decisions/:decisionId/brief/summary`, async (req, reply) => {
    const c = await ctx(req, reply);
    if (!c) return;
    const { decisionId } = req.params as { decisionId: string };
    return { summary: await decisionSummary(c.orgId, c.projectId, decisionId) };
  });

  /* ── edits (owner/pm) ── */

  app.post(`${P}/concepts/:conceptId/rename`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const { conceptId } = req.params as { conceptId: string };
    const b = req.body as { label?: unknown };
    if (!str(b?.label)) return reply.code(400).send({ error: "label required" });
    return run(
      reply,
      async () => (await renameConcept(c.orgId, c.projectId, conceptId, b.label as string, c.memberId), { ok: true }),
    );
  });

  app.post(`${P}/concepts/:conceptId/domain`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const { conceptId } = req.params as { conceptId: string };
    const b = req.body as { domainId?: unknown };
    if (!str(b?.domainId)) return reply.code(400).send({ error: "domainId required" });
    return run(
      reply,
      async () => (
        await setConceptDomain(c.orgId, c.projectId, conceptId, b.domainId as string, c.memberId),
        { ok: true }
      ),
    );
  });

  app.post(`${P}/concepts/:conceptId/merge`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const { conceptId } = req.params as { conceptId: string };
    const b = req.body as { intoId?: unknown };
    if (!str(b?.intoId)) return reply.code(400).send({ error: "intoId required" });
    return run(
      reply,
      async () => (await mergeConcepts(c.orgId, c.projectId, conceptId, b.intoId as string, c.memberId), { ok: true }),
    );
  });

  app.post(`${P}/placements`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const b = req.body as { itemKind?: unknown; itemId?: unknown; conceptId?: unknown; projectWide?: unknown };
    if ((b?.itemKind !== "surface" && b?.itemKind !== "decision") || !str(b?.itemId)) {
      return reply.code(400).send({ error: "itemKind (surface|decision) and itemId required" });
    }
    if (!str(b.conceptId) && b.projectWide !== true)
      return reply.code(400).send({ error: "conceptId or projectWide required" });
    const target = str(b.conceptId) ? { conceptId: b.conceptId } : { projectWide: true as const };
    return run(
      reply,
      async () => (
        await placeItem(
          c.orgId,
          c.projectId,
          b.itemKind as "surface" | "decision",
          b.itemId as string,
          target,
          c.memberId,
        ),
        { ok: true }
      ),
    );
  });

  app.post(`${P}/domains`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const b = req.body as { label?: unknown };
    if (!str(b?.label)) return reply.code(400).send({ error: "label required" });
    return run(reply, () => createDomain(c.orgId, c.projectId, b.label as string));
  });

  app.patch(`${P}/domains/:domainId`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const { domainId } = req.params as { domainId: string };
    const b = req.body as { label?: unknown; position?: unknown };
    const patch: { label?: string; position?: number } = {};
    if (b?.label !== undefined) {
      if (!str(b.label)) return reply.code(400).send({ error: "label must be a non-empty string" });
      patch.label = b.label;
    }
    if (b?.position !== undefined) {
      if (!Number.isInteger(b.position)) return reply.code(400).send({ error: "position must be an integer" });
      patch.position = b.position as number;
    }
    return run(reply, async () => (await updateDomain(c.orgId, c.projectId, domainId, patch), { ok: true }));
  });

  app.delete(`${P}/domains/:domainId`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const { domainId } = req.params as { domainId: string };
    return run(reply, async () => (await deleteDomain(c.orgId, c.projectId, domainId), { ok: true }));
  });

  app.put(`${P}/concept-rules`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    const b = req.body as { skip?: unknown };
    if (!Array.isArray(b?.skip) || !b.skip.every((s) => typeof s === "string")) {
      return reply.code(400).send({ error: "skip: string[] required" });
    }
    return run(reply, async () => (await setHttpRules(c.orgId, c.projectId, b.skip as string[]), { ok: true }));
  });

  app.post(`${P}/concepts/rebuild`, async (req, reply) => {
    const c = await ctx(req, reply, true);
    if (!c) return;
    await requestRebuild(c.orgId, c.projectId);
    return { ok: true };
  });
}
