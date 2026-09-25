import Fastify, { type FastifyInstance } from "fastify";
import { authHook } from "./auth-context.js";
import { authRoutes } from "./routes/auth.js";
import { orgRoutes } from "./routes/orgs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { ingestRoutes } from "./routes/ingest.js";
import { documentRoutes } from "./routes/documents.js";
import { conceptRoutes } from "./routes/concepts.js";
import { slackRoutes } from "./routes/slack.js";
import { githubWebhookRoutes } from "./routes/github-webhook.js";
import { slackEventsRoutes } from "./routes/slack-events.js";
import { queryClient } from "../db/client.js";
import { env } from "../env.js";
import { adoptionRoutesWith } from "../adoption/routes.js";

export function buildApp(adoptionProviders: Parameters<typeof adoptionRoutesWith>[0] = {}): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });

  app.addHook("onRequest", authHook);

  // Map thrown errors with a statusCode (e.g. ensureMember → 403) to HTTP responses.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // /healthz is the Railway probe; /health is the conventional name integrators reach for first.
  const health = async () => ({ ok: true, service: "lockstep-core" });
  app.get("/healthz", health);
  app.get("/health", health);
  app.get("/readyz", async () => {
    await queryClient`select 1`;
    return { ok: true, db: "up", deployment: env.LOCKSTEP_DEPLOYMENT };
  });

  void app.register(authRoutes);
  void app.register(orgRoutes);
  void app.register(sessionRoutes);
  void app.register(ledgerRoutes);
  void app.register(dashboardRoutes);
  void app.register(ingestRoutes);
  void app.register(documentRoutes);
  void app.register(conceptRoutes);
  void app.register(slackRoutes);
  void app.register(githubWebhookRoutes);
  void app.register(slackEventsRoutes);
  void app.register(adoptionRoutesWith(adoptionProviders));

  return app;
}
