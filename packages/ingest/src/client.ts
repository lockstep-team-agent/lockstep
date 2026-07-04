/** Thin authed HTTP client to core's /ingest/* worker endpoints (service-token auth). */

export interface WorkSource {
  sourceRef: string;
  sourceName: string | null;
  cursor: string | null;
}
export interface WorkItem {
  orgId: string;
  projectId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  sources: WorkSource[];
}

export interface ProposedItem {
  orgId: string;
  projectId: string;
  scopeKind: string;
  scopeRef: string;
  ruleText: string;
  decisionType?: string;
  provenance: unknown;
  connectionId: string;
  externalId: string;
  contentHash: string;
  confidence?: number; // 0..100
}

export class LockstepClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-lockstep-ingest-token": this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async getWork(): Promise<WorkItem[]> {
    const r = await this.req<{ work: WorkItem[] }>("GET", "/ingest/work");
    return r.work;
  }

  async postProposed(items: ProposedItem[]): Promise<{ filed: number; deduped: number }> {
    if (items.length === 0) return { filed: 0, deduped: 0 };
    return this.req("POST", "/ingest/proposed-decisions", { items });
  }

  async setWatermark(orgId: string, connectionId: string, sourceRef: string, cursor: string): Promise<void> {
    await this.req("POST", "/ingest/watermark", { orgId, connectionId, sourceRef, cursor });
  }

  async finalizeConnection(connectionId: string, connectedAccountId: string): Promise<void> {
    await this.req("POST", `/ingest/connections/${connectionId}/finalize`, { connectedAccountId });
  }
}
