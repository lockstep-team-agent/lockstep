import { apiGet } from "./api";
import type { ProjectOverview, DecisionDetail } from "./types";

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
  alternatives?: string[];
  reviewHint?: string;
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
  // Phase J: first-class deliberation fields + server-computed staleness (TOMASP timebox)
  rationale?: string | null;
  alternatives?: string[] | null;
  reviewAt?: string | null;
  proposedAt?: string;
  ageDays?: number;
  stale?: boolean;
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

/** Poll a connection's OAuth status (finalizes it server-side once Composio confirms active). */
export const checkConnectionStatus = (orgId: string, projectId: string, id: string) =>
  apiGet<{ status: string }>(`/orgs/${orgId}/projects/${projectId}/connections/${id}/status`);

/** Whether this org has the Lockstep GitHub App installed (drives the Members-page indicator). */
export const getGithubInstall = (orgId: string) =>
  apiGet<{ installed: boolean; accountLogin: string | null }>(`/orgs/${orgId}/github/install`);

/** Connectable sources (Slack channels / Notion databases) for the dashboard picker. */
export const getConnectionSources = (orgId: string, projectId: string, id: string) =>
  apiGet<{ sources: Array<{ id: string; name: string }> }>(
    `/orgs/${orgId}/projects/${projectId}/connections/${id}/sources`,
  );

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
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  status: string;
}
export const getGraph = (orgId: string, projectId: string) =>
  apiGet<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/orgs/${orgId}/projects/${projectId}/graph`);

/* ── v3 product layer ── */

export type DocState = "draft" | "review" | "active" | "archived";
export type ConstraintKind = "behavioral" | "launch_gate" | "scope_exclusion";

export interface SourceDocument {
  id: string;
  tool: "notion" | "gdocs" | "native";
  stateAuthority: "mirrored" | "native";
  title: string | null;
  url: string | null;
  state: DocState;
  ownerMemberId: string | null;
  constraintCounts: { binding: number; total: number };
  openConflicts: number;
  anchors: { total: number; needsReverify: number };
  lastSyncedAt: string | null;
}

export interface PendingStatusValue {
  connectionId: string;
  containerRef: string;
  containerName: string | null;
  value: string;
  firstSeenAt: string;
}

export interface DocumentDetail extends SourceDocument {
  constraints: Array<{
    id: string;
    ruleText: string;
    status: string;
    constraintKind: ConstraintKind | null;
    scopeRef: string;
    anchor: { heading: string | null; url: string | null; healthy: boolean };
  }>;
  extractionHistory: Array<{ id: string; at: string; status: string; confidence: number | null }>;
  writeBackLog: Array<{ id: string; at: string; kind: string; status: string; url: string | null }>;
}

export interface RatificationCandidate {
  id: string;
  ruleText: string;
  scopeKind: string;
  scopeRef: string;
  decisionType: string;
  constraintKind: ConstraintKind | null;
  confidence: number | null;
  provenances: ProvenanceRow[];
  doc: { id: string; title: string | null; url: string | null; state: DocState };
  anchor: { heading: string | null; url: string | null };
  conflict: { engDecisionId: string; engRuleText: string; surface: string } | null;
  lowConfidence: boolean;
  canRatify: boolean;
  blockedReason: string | null;
}

export interface StateMappingContainer {
  containerRef: string;
  containerName: string | null;
  statusProperty: string | null;
  knownValues: string[];
  mappings: Array<{ sourceValue: string; canonicalState: string }>;
  pendingValues: Array<{ value: string; firstSeenAt: string }>;
}

export interface ProjectCounts {
  review: { proposed: number; ratifications: number; conflicts: number; total: number };
  sources: number;
}

export const getDocuments = (orgId: string, projectId: string) =>
  apiGet<{ documents: SourceDocument[]; pendingStatusValues: PendingStatusValue[] }>(
    `/orgs/${orgId}/projects/${projectId}/documents`,
  );

export const getDocument = (orgId: string, projectId: string, docId: string) =>
  apiGet<DocumentDetail>(`/orgs/${orgId}/projects/${projectId}/documents/${docId}`);

export const getRatifications = (orgId: string, projectId: string) =>
  apiGet<{ candidates: RatificationCandidate[]; viewer: { memberId: string; role: string } }>(
    `/orgs/${orgId}/projects/${projectId}/ratifications`,
  );

export const getStateMappings = (orgId: string, projectId: string, connectionId: string) =>
  apiGet<{ containers: StateMappingContainer[] }>(
    `/orgs/${orgId}/projects/${projectId}/connections/${connectionId}/state-mappings`,
  );

export const getCounts = (orgId: string, projectId: string) =>
  apiGet<ProjectCounts>(`/orgs/${orgId}/projects/${projectId}/counts`);

export interface ProjectInsights {
  ratification: { ratified: number; rejected: number; rate: number };
  conflicts: {
    dismissed: number;
    resolved: number;
    rate: number;
    dismissReasons: Array<{ reason: string; count: number }>;
  };
  lowConfidence: { accepted: number; total: number; rate: number };
  anchors: { valid: number; total: number; rate: number };
}

export const getInsights = (orgId: string, projectId: string) =>
  apiGet<ProjectInsights>(`/orgs/${orgId}/projects/${projectId}/insights`);

export interface Feature {
  ref: string;
  label: string | null;
  docId: string | null;
  docTitle: string | null;
  constraintCounts: { binding: number; proposed: number; stale: number; expired: number; total: number };
  governedSurfaces: { confirmed: number; proposed: number };
  openConflicts: number;
}

export interface FeatureDetail {
  ref: string;
  label: string | null;
  doc: { id: string; title: string | null; url: string | null; state: string } | null;
  constraints: Array<{
    id: string;
    ruleText: string;
    status: string;
    constraintKind: string | null;
    scopeRef: string;
    anchorUrl: string | null;
    conflict: boolean;
  }>;
  governedSurfaces: Array<{
    surface: string;
    status: "proposed" | "confirmed";
    edgeId: string;
    implementing: { decisions: number; changes: number };
  }>;
  coverage: { constraintsWithActivity: number; totalConstraints: number; openConflicts: number };
}

export const getFeatures = (orgId: string, projectId: string) =>
  apiGet<{ features: Feature[] }>(`/orgs/${orgId}/projects/${projectId}/features`);

export const getFeature = (orgId: string, projectId: string, ref: string) =>
  apiGet<FeatureDetail>(`/orgs/${orgId}/projects/${projectId}/features/${encodeURIComponent(ref)}`);

export type ConflictKind = "pre_approval" | "drift";
export type ConflictStatus = "open" | "resolved_eng_revised" | "resolved_prd_amended" | "dismissed";

export interface ConflictView {
  id: string;
  kind: ConflictKind;
  status: ConflictStatus;
  surface: string;
  constraintDecisionId: string;
  engDecisionId: string | null;
  constraintRuleText: string;
  engRuleText: string | null;
  docId: string | null;
  docTitle: string | null;
  docUrl: string | null;
  dismissReason: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export const getConflicts = (orgId: string, projectId: string, status?: string) =>
  apiGet<{ conflicts: ConflictView[] }>(
    `/orgs/${orgId}/projects/${projectId}/conflicts${status ? `?status=${status}` : ""}`,
  );

export const conflictKindLabel = (k: ConflictKind): string => (k === "pre_approval" ? "pre-approval" : "drift");

export const constraintKindLabel = (k: ConstraintKind): string => k.replace(/_/g, " ");

export { timeAgo } from "./time";

export const getDecisionDetail = (orgId: string, projectId: string, id: string) =>
  apiGet<DecisionDetail>(`/orgs/${orgId}/projects/${projectId}/decisions/${id}`);

const VERB: Record<string, string> = {
  "decision.proposed": "proposed",
  "decision.acked": "acknowledged",
  "decision.confirmed": "confirmed",
  "decision.superseded": "superseded",
  "decision.provenance_added": "added a source to",
  "decision.review_updated": "updated the review date of",
  "decision.expired": "expired",
  "constraint.ratified": "ratified",
  "constraint.staled": "staled",
  "question.asked": "asked",
  "question.answered": "answered",
  "task.delegated": "delegated",
  "task.completed": "completed",
  "change.published": "changed",
  "dependency.registered": "registered a dependency on",
  "conflict.opened": "opened a conflict on",
  "conflict.resolved": "resolved a conflict on",
  "member.role_changed": "changed a role",
  "member.slack_linked": "linked Slack for",
  "repo.disconnected": "disconnected",
  "document.registered": "registered",
  "document.unregistered": "unregistered",
  "document.resync_requested": "requested a re-sync of",
  "document.state_changed": "changed the state of",
  "edge.confirmed": "confirmed an edge for",
  "edge.rejected": "rejected an edge for",
  "project.settings_updated": "updated project settings",
};

/** "alice-chen proposed “Auth tokens are JWT…”" — actor and object when known, a verb always. */
export function humanizeAudit(a: { action: string; actor: string | null; summary: string | null }): {
  actor: string | null;
  verb: string;
  object: string | null;
} {
  return { actor: a.actor, verb: VERB[a.action] ?? a.action.replace(/[._]/g, " "), object: a.summary };
}

export const entityHref = (base: string, kind: string | null, id: string | null): string | undefined => {
  if (!id) return undefined;
  if (kind === "decision") return `${base}/decisions/${id}`;
  if (kind === "question") return `${base}/questions#${id}`;
  if (kind === "task") return `${base}/tasks#${id}`;
  if (kind === "change_feed_entry") return `${base}/contracts`;
  if (kind === "dependency_edge") return `${base}/dependencies`;
  return undefined;
};
