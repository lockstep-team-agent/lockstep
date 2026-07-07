/**
 * Server-side Composio OAuth + source listing (@composio/core v0.13). This lets the DASHBOARD drive
 * Slack/Notion connect — the operator's Composio key stays server-side, never on a client machine or the
 * CLI. Mirrors the OAuth surface of `packages/ingest/.../ComposioConnector.ts` (KEEP IN SYNC — same auth
 * config + link + version pattern). The SDK loads via a computed dynamic import so core builds without it.
 *
 * The exported functions take an optional `client` (a `V3Client`) so tests can inject a fake; in prod they
 * default to a real Composio client built from `env.COMPOSIO_API_KEY`.
 */
import { env } from "../env.js";

export type Tool = "slack" | "notion" | "jira" | "confluence";

/** The subset of the v0.13 client surface we use. */
export interface V3Client {
  authConfigs: {
    list: (q: { toolkit?: string }) => Promise<{ items?: Array<{ id: string; toolkit?: { slug?: string } }> }>;
    create: (toolkit: string, opts: { type: string; name?: string }) => Promise<{ id: string }>;
  };
  connectedAccounts: {
    link: (
      userId: string,
      authConfigId: string,
      options?: { callbackUrl?: string },
    ) => Promise<{ redirectUrl?: string; id?: string }>;
    get: (id: string) => Promise<{ status?: string }>;
  };
  tools: {
    getRawComposioTools: (q: {
      toolkits: string[];
      limit?: number;
    }) => Promise<Array<{ slug?: string; version?: string }> | { items?: Array<{ slug?: string; version?: string }> }>;
    execute: (
      slug: string,
      body: { userId: string; arguments: Record<string, unknown>; version?: string },
    ) => Promise<{ data?: Record<string, unknown>; successful?: boolean; error?: string }>;
  };
}

let cached: V3Client | null = null;
async function defaultClient(): Promise<V3Client> {
  if (cached) return cached;
  if (!env.COMPOSIO_API_KEY) throw Object.assign(new Error("COMPOSIO_API_KEY not configured"), { statusCode: 501 });
  const spec = "@composio/core";
  const mod: Record<string, unknown> = await import(spec);
  const Composio = mod.Composio as new (opts: { apiKey: string }) => V3Client;
  cached = new Composio({ apiKey: env.COMPOSIO_API_KEY });
  return cached;
}

/** Reuse an existing managed auth config for the toolkit, else create one (Composio-managed OAuth). */
async function ensureAuthConfig(c: V3Client, tool: Tool): Promise<string> {
  const existing = await c.authConfigs.list({ toolkit: tool }).catch(() => ({ items: [] }));
  const found = (existing.items ?? []).find((a) => (a.toolkit?.slug ?? "").toLowerCase() === tool);
  if (found) return found.id;
  const created = await c.authConfigs.create(tool, { type: "use_composio_managed_auth", name: `lockstep-${tool}` });
  return created.id;
}

/** Start OAuth: returns a Composio-hosted URL to send the user to, plus the connectedAccountId to track. */
export async function link(
  tool: Tool,
  entity: string,
  callbackUrl: string,
  client?: V3Client,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const c = client ?? (await defaultClient());
  const authConfigId = await ensureAuthConfig(c, tool);
  const req = await c.connectedAccounts.link(entity, authConfigId, { callbackUrl });
  return { redirectUrl: req.redirectUrl ?? "", connectedAccountId: req.id ?? "" };
}

/** Whether a connected account has finished OAuth. */
export async function isActive(connectedAccountId: string, client?: V3Client): Promise<boolean> {
  const c = client ?? (await defaultClient());
  const acc = await c.connectedAccounts.get(connectedAccountId).catch(() => ({ status: "" }));
  return (acc.status ?? "").toUpperCase() === "ACTIVE";
}

/* ── source listing (channels / databases) — for the dashboard picker ── */

const arr = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function notionTitle(page: Record<string, unknown>): string {
  const rich = (t: unknown): string | null =>
    Array.isArray(t) && (t as Array<{ plain_text?: string }>)[0]?.plain_text
      ? (t as Array<{ plain_text?: string }>).map((x) => x.plain_text ?? "").join("")
      : null;
  const top = rich(page.title);
  if (top) return top;
  const props = page.properties as Record<string, unknown> | undefined;
  if (props)
    for (const p of Object.values(props)) {
      const t = rich((p as Record<string, unknown>)?.title);
      if (t) return t;
    }
  return "(untitled)";
}

let versionCache: Record<string, Record<string, string | undefined>> = {};
async function toolVersion(c: V3Client, tool: Tool, slug: string): Promise<string | undefined> {
  if (!versionCache[tool]) {
    const raw = await c.tools.getRawComposioTools({ toolkits: [tool], limit: 500 }).catch(() => []);
    const list = Array.isArray(raw) ? raw : (raw.items ?? []);
    const map: Record<string, string | undefined> = {};
    for (const t of list) if (t.slug) map[t.slug] = t.version;
    versionCache[tool] = map;
  }
  return versionCache[tool][slug];
}

async function exec(
  c: V3Client,
  tool: Tool,
  entity: string,
  slug: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const version = await toolVersion(c, tool, slug);
  const res = await c.tools.execute(slug, { userId: entity, arguments: args, version });
  if (res && res.successful === false) throw new Error(`composio ${slug} failed: ${res.error ?? "unknown"}`);
  return (res?.data ?? {}) as Record<string, unknown>;
}

export interface Source {
  id: string;
  name: string;
}

/** List the connectable sources (Slack channels / Notion databases) for a connected account. */
export async function listSources(tool: Tool, entity: string, client?: V3Client): Promise<Source[]> {
  const c = client ?? (await defaultClient());
  if (tool === "slack") {
    const d = await exec(c, tool, entity, "SLACK_FIND_CHANNELS", {
      query: "",
      limit: 200,
      exclude_archived: true,
      types: "public_channel,private_channel",
    });
    return arr(d.channels ?? d.results).flatMap((ch) =>
      ch.id ? [{ id: String(ch.id), name: str(ch.name) || String(ch.id) }] : [],
    );
  }
  if (tool === "notion") {
    const d = await exec(c, tool, entity, "NOTION_SEARCH_NOTION_PAGE", { filter_value: "database", page_size: 100 });
    return arr(d.results).flatMap((r) => (r.id ? [{ id: String(r.id), name: notionTitle(r) }] : []));
  }
  return [];
}

/** Test-only: reset module caches so an injected client is used cleanly. */
export function __resetComposioCaches(): void {
  cached = null;
  versionCache = {};
}
