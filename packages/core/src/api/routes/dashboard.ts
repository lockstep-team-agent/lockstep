import type { FastifyInstance } from "fastify";
import { ensureMember } from "../../auth/auth-service.js";
import { ensureProjectVisible } from "../guards.js";
import { orgOverview, projectOverview } from "../../dashboard/dashboard-service.js";
import { projectInsights } from "../../documents/insights-service.js";

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
}
