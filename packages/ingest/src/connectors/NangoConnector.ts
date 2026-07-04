import type { SourceConnector, Unit, Channel } from "./SourceConnector.js";

/**
 * Self-hosted / data-residency alternative to Composio, behind the same SourceConnector interface
 * (the Phase-4 swap). Nango proxies provider APIs so tokens stay in infrastructure you run. This impl
 * proxies the Slack Web API through Nango's proxy endpoint; other providers follow the same shape.
 *
 * Env: NANGO_SECRET_KEY (+ base URL for self-host). Per-connection: connectionId + providerConfigKey.
 * Verified against Nango's proxy contract (Authorization + Connection-Id + Provider-Config-Key headers).
 */
export class NangoConnector implements SourceConnector {
  constructor(
    private readonly secretKey: string,
    private readonly connectionId: string,
    private readonly providerConfigKey = "slack",
    private readonly baseUrl = process.env.NANGO_HOST || "https://api.nango.dev",
    private readonly windowDays = 7,
  ) {}

  private async proxy(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/proxy${path}`, {
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Connection-Id": this.connectionId,
        "Provider-Config-Key": this.providerConfigKey,
      },
    });
    if (!res.ok) throw new Error(`nango proxy ${path} → ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    // Nango returns the provider payload (sometimes wrapped in {data}).
    return (body.data ?? body) as Record<string, unknown>;
  }

  async listChannels(): Promise<Channel[]> {
    const d = await this.proxy(`/api/conversations.list?limit=200&exclude_archived=true`);
    const chans = (d.channels ?? []) as Array<{ id?: string; name?: string }>;
    return chans.flatMap((c) => (c.id ? [{ id: c.id, name: c.name ?? c.id }] : []));
  }

  async listUnitsSince(channel: string, sinceCursor: string | null): Promise<Unit[]> {
    const oldest =
      sinceCursor && /^\d+(\.\d+)?$/.test(sinceCursor)
        ? sinceCursor
        : String(Math.floor(Date.now() / 1000) - this.windowDays * 86400);
    const hist = await this.proxy(`/api/conversations.history?channel=${channel}&oldest=${oldest}&limit=200`);
    const messages = (hist.messages ?? []) as Array<Record<string, unknown>>;
    const units: Unit[] = [];
    for (const m of messages) {
      const ts = String(m.ts ?? "");
      if (!ts || (m.thread_ts && m.thread_ts !== m.ts)) continue;
      const lines = [`${String(m.user ?? "unknown")}: ${String(m.text ?? "")}`];
      const authors = new Set<string>(m.user ? [String(m.user)] : []);
      if (Number(m.reply_count ?? 0) > 0) {
        const thread = await this.proxy(`/api/conversations.replies?channel=${channel}&ts=${ts}`);
        for (const r of (thread.messages ?? []) as Array<Record<string, unknown>>) {
          if (String(r.ts) === ts) continue;
          lines.push(`${String(r.user ?? "unknown")}: ${String(r.text ?? "")}`);
          if (r.user) authors.add(String(r.user));
        }
      }
      units.push({ externalId: `${channel}/${ts}`, sourceRef: channel, ts, text: lines.join("\n"), authors: [...authors] });
    }
    return units;
  }
}
