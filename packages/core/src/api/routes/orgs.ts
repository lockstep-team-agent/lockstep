import type { FastifyInstance } from "fastify";
import { createOrg, createProject, invite, listMemberships, connectRepo } from "../../auth/auth-service.js";

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    return {
      principal: { githubLogin: p.githubLogin, githubUserId: p.githubUserId },
      memberships: await listMemberships(p.id),
    };
  });

  app.post("/orgs", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const b = req.body as { name?: string } | undefined;
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    return createOrg(p, b.name);
  });

  app.post("/orgs/:orgId/projects", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId } = req.params as { orgId: string };
    const b = req.body as { name?: string } | undefined;
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    return createProject(p, orgId, b.name);
  });

  app.post("/orgs/:orgId/projects/:projectId/invite", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const b = req.body as { githubLogin?: string; role?: string } | undefined;
    if (!b?.githubLogin) return reply.code(400).send({ error: "githubLogin required" });
    return invite(p, orgId, projectId, b.githubLogin, b.role ?? "member");
  });

  app.post("/orgs/:orgId/projects/:projectId/repos", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const b = req.body as { gitRemote?: string; isMonorepo?: boolean } | undefined;
    if (!b?.gitRemote) return reply.code(400).send({ error: "gitRemote required" });
    return connectRepo(p, orgId, projectId, b.gitRemote, b.isMonorepo ?? false);
  });
}
