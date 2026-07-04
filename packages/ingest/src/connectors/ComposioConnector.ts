import type { SourceConnector, Unit, Channel } from "./SourceConnector.js";

export type Tool = "slack" | "jira" | "notion" | "confluence";

/**
 * Composio-backed connector for every human-coordination source. One class, per-tool routing — the
 * distillation funnel is source-agnostic (it just consumes Units). Verified Composio slugs:
 *   Slack:      SLACK_FIND_CHANNELS, SLACK_FETCH_CONVERSATION_HISTORY, SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION
 *   Jira:       JIRA_GET_ALL_PROJECTS, JIRA_SEARCH_ISSUES (JQL)
 *   Notion:     NOTION_SEARCH_NOTION_PAGE, NOTION_QUERY_DATABASE, NOTION_GET_PAGE_MARKDOWN
 *   Confluence: CONFLUENCE_SEARCH, CONFLUENCE_GET_PAGE_BY_ID (best-effort; verify against installed SDK)
 *
 * The @composio/core SDK loads via a computed dynamic import so this file typechecks / the worker builds
 * even without the package (CI runs only StubConnector). `exec()` is the one place the SDK call shape
 * lives; it's exercised by the live test, not CI. Composio holds the OAuth token; we never see it.
 */
export class ComposioConnector implements SourceConnector {
  private client: unknown;

  constructor(
    private readonly apiKey: string,
    private readonly entity: string,
    private readonly tool: Tool = "slack",
    private readonly defaultWindowDays = 7,
  ) {}

  private async getClient(): Promise<Record<string, unknown>> {
    if (!this.client) {
      const spec = "@composio/core";
      const mod: Record<string, unknown> = await import(spec);
      const Composio = mod.Composio as new (opts: { apiKey: string }) => unknown;
      this.client = new Composio({ apiKey: this.apiKey });
    }
    return this.client as Record<string, unknown>;
  }

  private async exec(slug: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = (await this.getClient()) as { tools: { execute: (args: unknown) => Promise<unknown> } };
    const res = (await client.tools.execute({
      entity: this.entity,
      app: this.tool,
      tool: slug,
      input,
    })) as { data?: Record<string, unknown>; successful?: boolean; error?: string };
    if (res && res.successful === false) throw new Error(`composio ${slug} failed: ${res.error ?? "unknown"}`);
    return (res?.data ?? {}) as Record<string, unknown>;
  }

  private sinceEpoch(cursor: string | null): number {
    if (cursor && /^\d+(\.\d+)?$/.test(cursor)) return Math.floor(Number(cursor));
    return Math.floor(Date.now() / 1000) - this.defaultWindowDays * 86400;
  }
  private sinceIso(cursor: string | null): string {
    if (cursor && cursor.includes("-")) return cursor;
    return new Date((Math.floor(Date.now() / 1000) - this.defaultWindowDays * 86400) * 1000).toISOString();
  }

  /* ── OAuth (control-plane) ── */

  async initiate(): Promise<{ redirectUrl: string; connectedAccountId: string }> {
    const client = (await this.getClient()) as {
      getEntity?: (id: string) => Promise<{ initiateConnection: (o: unknown) => Promise<unknown> }>;
      connectedAccounts?: { initiate: (o: unknown) => Promise<unknown> };
    };
    if (client.getEntity) {
      const entity = await client.getEntity(this.entity);
      const conn = (await entity.initiateConnection({ appName: this.tool, authScheme: "OAUTH2" })) as {
        redirectUrl?: string;
        redirect_url?: string;
        connectedAccountId?: string;
        id?: string;
      };
      return {
        redirectUrl: conn.redirectUrl ?? conn.redirect_url ?? "",
        connectedAccountId: conn.connectedAccountId ?? conn.id ?? "",
      };
    }
    const conn = (await client.connectedAccounts!.initiate({ entityId: this.entity, app: this.tool })) as {
      redirectUrl?: string;
      connectedAccountId?: string;
      id?: string;
    };
    return { redirectUrl: conn.redirectUrl ?? "", connectedAccountId: conn.connectedAccountId ?? conn.id ?? "" };
  }

  async isActive(connectedAccountId: string): Promise<boolean> {
    const client = (await this.getClient()) as {
      connectedAccounts?: { get: (o: unknown) => Promise<{ status?: string }> };
    };
    if (!client.connectedAccounts?.get) return true;
    const acc = await client.connectedAccounts.get({ connectedAccountId });
    return (acc.status ?? "").toUpperCase() === "ACTIVE";
  }

  /* ── Sources (channels / projects / spaces / databases) ── */

  async listChannels(): Promise<Channel[]> {
    switch (this.tool) {
      case "slack": {
        const d = await this.exec("SLACK_FIND_CHANNELS", { limit: 200, exclude_archived: true });
        return arr(d.channels ?? d.results).flatMap((c) => (c.id ? [{ id: String(c.id), name: str(c.name) || String(c.id) }] : []));
      }
      case "jira": {
        const d = await this.exec("JIRA_GET_ALL_PROJECTS", {});
        return arr(d.projects ?? d.values ?? d).flatMap((p) => (p.key ? [{ id: String(p.key), name: str(p.name) || String(p.key) }] : []));
      }
      case "notion": {
        const d = await this.exec("NOTION_SEARCH_NOTION_PAGE", { filter_value: "database", page_size: 100 });
        return arr(d.results).flatMap((r) => (r.id ? [{ id: String(r.id), name: notionTitle(r) }] : []));
      }
      case "confluence": {
        const d = await this.exec("CONFLUENCE_GET_SPACES", { limit: 100 });
        return arr(d.results ?? d.spaces).flatMap((s) => (s.key || s.id ? [{ id: String(s.key ?? s.id), name: str(s.name) }] : []));
      }
    }
  }

  /* ── Units ── */

  async listUnitsSince(sourceRef: string, sinceCursor: string | null): Promise<Unit[]> {
    switch (this.tool) {
      case "slack":
        return this.slackUnits(sourceRef, sinceCursor);
      case "jira":
        return this.jiraUnits(sourceRef, sinceCursor);
      case "notion":
        return this.notionUnits(sourceRef, sinceCursor);
      case "confluence":
        return this.confluenceUnits(sourceRef, sinceCursor);
    }
  }

  private async slackUnits(channel: string, cursor: string | null): Promise<Unit[]> {
    const hist = await this.exec("SLACK_FETCH_CONVERSATION_HISTORY", {
      channel,
      oldest: String(this.sinceEpoch(cursor)),
      limit: 200,
    });
    const units: Unit[] = [];
    for (const m of arr(hist.messages)) {
      const ts = str(m.ts);
      if (!ts || (m.thread_ts && m.thread_ts !== m.ts)) continue;
      const lines = [renderSlack(m)];
      const authors = new Set<string>(author(m));
      if (Number(m.reply_count ?? 0) > 0) {
        const thread = await this.exec("SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION", { channel, ts });
        for (const r of arr(thread.messages)) {
          if (str(r.ts) === ts) continue;
          lines.push(renderSlack(r));
          author(r).forEach((a) => authors.add(a));
        }
      }
      units.push({ externalId: `${channel}/${ts}`, sourceRef: channel, ts, text: lines.join("\n"), authors: [...authors], permalink: str(m.permalink) || undefined });
    }
    return units;
  }

  private async jiraUnits(projectKey: string, cursor: string | null): Promise<Unit[]> {
    const since = this.sinceIso(cursor).slice(0, 10); // JQL date
    const jql = `project = "${projectKey}" AND updated >= "${since}" ORDER BY updated DESC`;
    const d = await this.exec("JIRA_SEARCH_ISSUES", { jql, maxResults: 100, fields: ["summary", "description", "comment", "updated"] });
    const units: Unit[] = [];
    for (const issue of arr(d.issues)) {
      const key = str(issue.key);
      const f = (issue.fields ?? {}) as Record<string, unknown>;
      const comments = arr((f.comment as Record<string, unknown>)?.comments).map((c) => `${author(c)[0] ?? "?"}: ${plain(c.body)}`);
      const text = `${key} ${str(f.summary)}\n${plain(f.description)}\n${comments.join("\n")}`.trim();
      const ts = str(f.updated) || new Date().toISOString();
      units.push({ externalId: `${projectKey}/${key}`, sourceRef: projectKey, ts, text, authors: comments.length ? [] : [], permalink: str(issue.self) || undefined });
    }
    return units;
  }

  private async notionUnits(sourceRef: string, cursor: string | null): Promise<Unit[]> {
    const isDb = /^[0-9a-f]{8}-?[0-9a-f]{4}/i.test(sourceRef);
    const listing = isDb
      ? await this.exec("NOTION_QUERY_DATABASE", { database_id: sourceRef, page_size: 100 })
      : await this.exec("NOTION_SEARCH_NOTION_PAGE", { query: sourceRef, filter_value: "page", page_size: 100 });
    const since = this.sinceIso(cursor);
    const units: Unit[] = [];
    for (const page of arr(listing.results)) {
      const pageId = str(page.id);
      const edited = str(page.last_edited_time) || since;
      if (edited < since) continue;
      const md = await this.exec("NOTION_GET_PAGE_MARKDOWN", { page_id: pageId });
      const text = `${notionTitle(page)}\n${str(md.markdown ?? md.content ?? md.text)}`.trim();
      units.push({ externalId: `${sourceRef}/${pageId}`, sourceRef, ts: edited, text, authors: [], permalink: str(page.url) || undefined });
    }
    return units;
  }

  private async confluenceUnits(spaceKey: string, cursor: string | null): Promise<Unit[]> {
    const since = this.sinceIso(cursor).slice(0, 10);
    const d = await this.exec("CONFLUENCE_SEARCH", { cql: `space = "${spaceKey}" AND lastmodified >= "${since}"`, limit: 100 });
    const units: Unit[] = [];
    for (const r of arr(d.results ?? d.pages)) {
      const id = str(r.id ?? (r.content as Record<string, unknown>)?.id);
      if (!id) continue;
      const page = await this.exec("CONFLUENCE_GET_PAGE_BY_ID", { id, expand: "body.storage,version" });
      const body = plain((page.body as Record<string, unknown>)?.storage ?? page.body);
      const ts = str((page.version as Record<string, unknown>)?.when) || this.sinceIso(cursor);
      units.push({ externalId: `${spaceKey}/${id}`, sourceRef: spaceKey, ts, text: `${str(page.title)}\n${body}`.trim(), authors: [], permalink: str(page._links && (page._links as Record<string, unknown>).webui) || undefined });
    }
    return units;
  }
}

/* helpers — defensive against varying Composio response shapes */
function arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function author(m: Record<string, unknown>): string[] {
  const a = m.user ?? m.username ?? m.author ?? (m.author as Record<string, unknown>)?.displayName ?? m.bot_id;
  return a ? [str(a)] : [];
}
function renderSlack(m: Record<string, unknown>): string {
  return `${str(m.user ?? m.username ?? "unknown")}: ${str(m.text)}`;
}
function plain(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.value === "string") return o.value; // confluence body.storage.value
    return JSON.stringify(v).slice(0, 4000); // ADF / rich text fallback
  }
  return "";
}
function notionTitle(page: Record<string, unknown>): string {
  const props = page.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const p of Object.values(props)) {
      const t = (p as Record<string, unknown>)?.title as Array<{ plain_text?: string }> | undefined;
      if (Array.isArray(t) && t[0]?.plain_text) return t.map((x) => x.plain_text).join("");
    }
  }
  return str(page.title) || "(untitled)";
}
