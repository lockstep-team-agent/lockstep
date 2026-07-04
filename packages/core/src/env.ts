import { z } from "zod";

/**
 * 12-factor config. Identical shape for managed cloud and self-host;
 * only values differ. Parsed once at boot — fail fast on misconfig.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  LOCKSTEP_API_URL: z.string().url().default("http://localhost:8080"),

  DATABASE_URL: z.string().min(1),

  TOKEN_SIGNING_SECRET: z.string().min(1).default("dev-only-change-me"),

  // GitHub App — required in production, optional in dev so the server boots.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(), // for the dashboard web OAuth code exchange
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // v3 product layer: first-party Slack app. The bot token sends the Edit modal (views.open) from
  // the interactivity handler; the signing secret verifies POST /webhooks/slack/actions. The worker
  // uses the same bot token to send ratification digests. All optional so core boots without Slack.
  SLACK_BOT_TOKEN: z.string().optional(),
  LOCKSTEP_SLACK_SIGNING_SECRET: z.string().optional(),

  // v2 ingestion: Composio connector key (worker + OAuth) and the shared service token the ingest
  // worker presents to the /ingest/* worker endpoints. Both optional so core boots without ingestion.
  COMPOSIO_API_KEY: z.string().optional(),
  LOCKSTEP_INGEST_TOKEN: z.string().optional(),

  LOCKSTEP_DEPLOYMENT: z.enum(["cloud", "self-host"]).default("self-host"),

  // Dev-only login bypass (never honored when NODE_ENV=production).
  LOCKSTEP_DEV_LOGIN: z
    .string()
    .optional()
    .default("")
    .transform((v) => v === "1" || v === "true"),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);

export const isProd = env.NODE_ENV === "production";
