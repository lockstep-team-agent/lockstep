import type { FastifyInstance } from "fastify";
import { ensureMember } from "../../auth/auth-service.js";
import { orgOverview, projectOverview } from "../../dashboard/dashboard-service.js";

/** Read endpoints for the dashboard — principal + org-membership guarded (no session needed). */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/orgs/:orgId/overview", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId } = req.params as { orgId: string };
    await ensureMember(orgId, p.id); // throws 403 if not a member
    return orgOverview(orgId);
  });

  app.get("/orgs/:orgId/projects/:projectId/overview", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    await ensureMember(orgId, p.id);
    return projectOverview(orgId, projectId);
  });
}
