/** Thin authed HTTP client to core's /ingest/* and /internal/* worker endpoints (service-token auth). */

import type { ProposedDocItem } from "./docFunnel.js";

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

/* ── v3 document layer (core's /internal/documents + /internal/writebacks) ── */

export interface DocWorkItem {
  orgId: string;
  projectId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  containers: Array<{ containerRef: string; containerName: string | null; statusProperty: string | null }>;
  /** Standalone/native docs (registered by URL, not swept from a database) that need extraction. */
  docs: Array<{ docId: string; externalId: string; state: string; knownSectionHashes: string[] }>;
}

/** Raw listing-level doc facts from the sweep — core owns state resolution, never the worker (D4). */
export interface SweptDoc {
  externalId: string;
  containerRef: string;
  title: string | null;
  url: string | null;
  rawStateValue: string | null;
  ownerRef: string | null;
  lastEditedTime: string | null;
}

export interface SweepDirective {
  docId: string;
  externalId: string;
  state: string;
  shouldExtract: boolean;
  knownSectionHashes: string[];
}

export interface PendingWriteback {
  id: string;
  orgId: string;
  tool: "notion" | "slack";
  kind: "conflict_comment" | "slack_digest";
  targetRef: string; // notion page id (conflict_comment) or Slack user id (slack_digest)
  payload: unknown;
  connection: { entity: string; connectedAccountId: string | null; tool: string } | null;
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

  /* ── v3 document layer ── */

  async getDocumentWork(): Promise<DocWorkItem[]> {
    const r = await this.req<{ work: DocWorkItem[] }>("GET", "/internal/documents/work");
    return r.work;
  }

  async upsertDocuments(connectionId: string, docs: SweptDoc[]): Promise<SweepDirective[]> {
    if (docs.length === 0) return [];
    const r = await this.req<{ results: SweepDirective[] }>("POST", "/internal/documents/upsert", {
      connectionId,
      docs,
    });
    return r.results;
  }

  async postDocCandidates(
    docId: string,
    items: ProposedDocItem[],
    docContentHash?: string,
  ): Promise<{ filed: number; fused: number; deduped: number; conflicts: number }> {
    return this.req("POST", `/internal/documents/${docId}/candidates`, { items, docContentHash });
  }

  async getPendingWritebacks(): Promise<PendingWriteback[]> {
    const r = await this.req<{ writebacks: PendingWriteback[] }>("GET", "/internal/writebacks/pending");
    return r.writebacks;
  }

  async markWritebackDone(id: string, ok: boolean, resultRef?: string): Promise<void> {
    await this.req("POST", `/internal/writebacks/${id}/done`, { ok, resultRef });
  }
}
