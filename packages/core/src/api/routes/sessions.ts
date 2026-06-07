import type { FastifyInstance } from "fastify";
import { registerSession } from "../session-context.js";

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions/register", async (req, reply) => {
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    const b = req.body as { gitRemote?: string; cwd?: string; vendor?: string } | undefined;
    if (!b?.gitRemote) return reply.code(400).send({ error: "gitRemote required" });
    const ctx = await registerSession(p, { gitRemote: b.gitRemote, cwd: b.cwd, vendor: b.vendor });
    if (!ctx) {
      return reply.code(404).send({ error: "unregistered_repo", hint: "connect this repo to a project first" });
    }
    return ctx;
  });
}
