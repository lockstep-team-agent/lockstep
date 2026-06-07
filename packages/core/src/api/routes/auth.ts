import type { FastifyInstance } from "fastify";
import * as gh from "../../auth/github.js";
import { completeLogin, devLogin } from "../../auth/auth-service.js";
import { env } from "../../env.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/device/start", async () => {
    const d = await gh.startDeviceFlow();
    return {
      device_code: d.device_code,
      user_code: d.user_code,
      verification_uri: d.verification_uri,
      interval: d.interval,
      expires_in: d.expires_in,
    };
  });

  app.post("/auth/device/poll", async (req, reply) => {
    const body = req.body as { device_code?: string } | undefined;
    if (!body?.device_code) return reply.code(400).send({ error: "device_code required" });
    const r = await gh.pollDeviceFlow(body.device_code);
    if (r.access_token) {
      const out = await completeLogin(r.access_token);
      return { status: "ok", token: out.token, githubLogin: out.githubLogin, activatedProjects: out.activatedProjects };
    }
    return { status: "pending", error: r.error };
  });

  // Dev-only bypass (no GitHub). Strictly gated so it can never ship in prod.
  if (env.LOCKSTEP_DEV_LOGIN && env.NODE_ENV !== "production") {
    app.post("/auth/dev-login", async (req, reply) => {
      const b = req.body as { githubUserId?: number; githubLogin?: string } | undefined;
      if (!b?.githubUserId || !b?.githubLogin) {
        return reply.code(400).send({ error: "githubUserId and githubLogin required" });
      }
      const out = await devLogin(b.githubUserId, b.githubLogin);
      return { status: "ok", token: out.token, githubLogin: out.githubLogin, activatedProjects: out.activatedProjects };
    });
  }
}
