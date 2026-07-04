import { apiGet } from "./api";
import type { ProjectOverview } from "./types";

export const getOverview = (orgId: string, projectId: string) =>
  apiGet<ProjectOverview>(`/orgs/${orgId}/projects/${projectId}/overview`);

/* ── v2 ingestion: review queue + connections ── */

export interface ProvenanceEvidence {
  externalId: string;
  quote: string;
}
export interface Provenance {
  source?: string;
  url?: string | null;
  evidence?: ProvenanceEvidence[];
  confidence?: number;
  decidedBy?: string[];
  scopeHint?: string;
  rationale?: string;
  supersedes?: string;
}
export interface ProvenanceRow {
  source: string;
  externalId: string | null;
  url: string | null;
  evidence: ProvenanceEvidence[] | null;
  confidence: number | null;
}
export interface ProposedDecision {
  id: string;
  scopeKind: string;
  scopeRef: string;
  status: string;
  origin: string;
  ruleText: string;
  decisionType: string;
  impact: number;
  provenance: Provenance | null;
  provenances?: ProvenanceRow[];
  createdAt: string;
}
export interface SourceConnection {
  id: string;
  tool: string;
  entity: string;
  status: string;
  connectedAccountId: string | null;
}
export interface AllowlistEntry {
  id: string;
  connectionId: string;
  sourceKind: string;
  sourceRef: string;
  sourceName: string | null;
  enabled: boolean;
}

export const getProposed = (orgId: string, projectId: string) =>
  apiGet<{ decisions: ProposedDecision[] }>(`/orgs/${orgId}/projects/${projectId}/proposed`);

export const getConnections = (orgId: string, projectId: string) =>
  apiGet<{ connections: SourceConnection[] }>(`/orgs/${orgId}/projects/${projectId}/connections`);

export const getAllowlist = (orgId: string, projectId: string) =>
  apiGet<{ allowlist: AllowlistEntry[] }>(`/orgs/${orgId}/projects/${projectId}/allowlist`);

export const searchDecisions = (orgId: string, projectId: string, qs: string) =>
  apiGet<{ decisions: ProposedDecision[] }>(`/orgs/${orgId}/projects/${projectId}/decisions/search${qs}`);

export interface GraphNode {
  id: string;
  kind: string;
  ref: string;
  label: string | null;
  source: string;
}
export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: string;
}
export const getGraph = (orgId: string, projectId: string) =>
  apiGet<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/orgs/${orgId}/projects/${projectId}/graph`);

export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  if (dd < 30) return `${dd}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const humanizeAction = (a: string): string => a.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
