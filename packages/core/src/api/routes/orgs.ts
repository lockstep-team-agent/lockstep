import type { FastifyInstance } from "fastify";
import {
  createOrg,
  createProject,
  invite,
  listMemberships,
  connectRepo,
  connectOrJoin,
} from "../../auth/auth-service.js";
import { ensureMember, requireProjectRole } from "../guards.js";
import { recordInstallation, getInstallation } from "../../graph/ownership-service.js";

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

  // Smart connect: join-by-GitHub-access or create. The CLI's `lockstep connect` uses this.
  app.post("/connect", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const b = req.body as { gitRemote?: string; project?: string } | undefined;
    if (!b?.gitRemote) return reply.code(400).send({ error: "gitRemote required" });
    return connectOrJoin(p, b.gitRemote, b.project);
  });

  app.post("/orgs/:orgId/projects/:projectId/repos", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    if (!(await requireProjectRole(reply, orgId, projectId, memberId, ["owner", "pm"]))) return;
    const b = req.body as { gitRemote?: string; isMonorepo?: boolean } | undefined;
    if (!b?.gitRemote) return reply.code(400).send({ error: "gitRemote required" });
    return connectRepo(p, orgId, projectId, b.gitRemote, b.isMonorepo ?? false);
  });

  // Record the GitHub App installation for this org (dashboard install flow). The installation id is
  // verified against GitHub via the App JWT, so a member can't attach an arbitrary id.
  app.post("/orgs/:orgId/github/install", async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { installationId?: number | string } | undefined;
    const installationId = Number(b?.installationId);
    if (!installationId) return reply.code(400).send({ error: "installationId required" });
    try {
      return await recordInstallation(orgId, installationId);
    } catch {
      return reply.code(400).send({ error: "installation not found on GitHub" });
    }
  });

  app.get("/orgs/:orgId/github/install", async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    return getInstallation(orgId);
  });
}
