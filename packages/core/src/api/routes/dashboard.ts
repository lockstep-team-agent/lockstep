import type { FastifyInstance } from "fastify";
import { ensureMember } from "../../auth/auth-service.js";
import { ensureProjectVisible } from "../guards.js";
import { orgOverview, projectOverview, decisionDetail } from "../../dashboard/dashboard-service.js";
import { projectInsights } from "../../documents/insights-service.js";
import { ackDecision, proposeDecision } from "../../ledger/ledger-service.js";
import { auditExport, toCsv } from "../../dashboard/audit-export.js";

/** Read endpoints for the dashboard — principal + org-membership guarded (no session needed). */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/orgs/:orgId/overview", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId } = req.params as { orgId: string };
    const m = await ensureMember(orgId, p.id); // throws 403 if not a member
    return orgOverview(orgId, m.id);
  });

  app.get("/orgs/:orgId/projects/:projectId/overview", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const m = await ensureMember(orgId, p.id);
    if (!(await ensureProjectVisible(reply, orgId, projectId, m.id))) return;
    return projectOverview(orgId, projectId, m.id);
  });

  app.get("/orgs/:orgId/projects/:projectId/insights", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const m = await ensureMember(orgId, p.id); // throws 403 if not an org member
    if (!(await ensureProjectVisible(reply, orgId, projectId, m.id))) return;
    return projectInsights(orgId, projectId);
  });

  // Compliance export: one row per decision version — who proposed, who approved, when, from where.
  app.get("/orgs/:orgId/projects/:projectId/audit-export", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const m = await ensureMember(orgId, p.id);
    if (!(await ensureProjectVisible(reply, orgId, projectId, m.id))) return;
    const { format = "csv" } = req.query as { format?: string };
    if (format !== "csv" && format !== "json") return reply.code(400).send({ error: "format must be csv or json" });
    const { projectName, rows } = await auditExport(orgId, projectId);
    const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const filename = `lockstep-audit-${slug}-${new Date().toISOString().slice(0, 10)}.${format}`;
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    if (format === "json") return reply.type("application/json; charset=utf-8").send({ rows });
    return reply.type("text/csv; charset=utf-8").send(toCsv(rows));
  });

  // ── Web-facing decision reads/writes — member auth, no MCP session (the dashboard has none) ──

  app.get("/orgs/:orgId/projects/:projectId/decisions/:id", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const m = await ensureMember(orgId, p.id);
    if (!(await ensureProjectVisible(reply, orgId, projectId, m.id))) return;
    const d = await decisionDetail(orgId, projectId, id);
    if (!d) return reply.code(404).send({ error: "not_found" });
    return d;
  });

  app.post("/orgs/:orgId/projects/:projectId/decisions/:id/ack", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const m = await ensureMember(orgId, p.id);
    if (!(await ensureProjectVisible(reply, orgId, projectId, m.id))) return;
    const b = req.body as { version?: number; verdict?: string } | undefined;
    if (b?.version === undefined) return reply.code(400).send({ error: "version required" });
    if (!(await decisionDetail(orgId, projectId, id))) return reply.code(404).send({ error: "not_found" });
    return ackDecision(orgId, id, b.version, m.id, b.verdict ?? "ack");
  });

  app.post("/orgs/:orgId/projects/:projectId/decisions", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const m = await ensureMember(orgId, p.id);
    if (!(await ensureProjectVisible(reply, orgId, projectId, m.id))) return;
    const b = req.body as
      | {
          scopeKind?: string;
          scopeRef?: string;
          ruleText?: string;
          baseVersion?: number;
          decisionType?: string;
          rationale?: string;
          alternatives?: string[];
          reviewAt?: string;
          supersedes?: string;
        }
      | undefined;
    if (!b?.scopeKind || !b?.scopeRef || !b?.ruleText || b.baseVersion === undefined) {
      return reply.code(400).send({ error: "scopeKind, scopeRef, ruleText, baseVersion required" });
    }
    const reviewAt = b.reviewAt ? new Date(b.reviewAt) : undefined;
    if (reviewAt && Number.isNaN(reviewAt.getTime())) return reply.code(400).send({ error: "reviewAt must be an ISO date" });
    return proposeDecision(orgId, {
      projectId,
      memberId: m.id,
      scopeKind: b.scopeKind,
      scopeRef: b.scopeRef,
      ruleText: b.ruleText,
      baseVersion: b.baseVersion,
      decisionType: b.decisionType,
      rationale: b.rationale,
      alternatives: b.alternatives,
      reviewAt,
      provenance: b.supersedes ? { source: "web", supersedes: b.supersedes } : { source: "web" },
    });
  });
}
