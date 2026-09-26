/** Typed fetchers for the concept-ledger shell (LOCKSTEP_NEW_UI). Server-only (reads the auth cookie). */
import { apiGet } from "./api";

export const newUiEnabled = (): boolean => process.env.LOCKSTEP_NEW_UI === "1";

const P = (orgId: string, projectId: string) => `/orgs/${orgId}/projects/${projectId}`;
const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface ConceptCounts {
  surfaces: number;
  decisions: number;
  suggested: number;
  failed: number;
  conflicts: number;
}
export interface OutlineConcept {
  id: string;
  key: string;
  label: string;
  domainId: string | null;
  domainState: string;
  counts: ConceptCounts;
}
export interface OutlineDomain {
  id: string;
  label: string;
  counts: { concepts: number; items: number; suggested: number; failed: number; conflicts: number };
  concepts: OutlineConcept[];
  nextCursor: string | null;
}
export interface Outline {
  domains: OutlineDomain[];
  viewer: { role: string };
  groups: { project_wide: { items: number }; unplaced: { items: number }; unassigned_domain: { concepts: number } };
}
export interface GroupItem {
  itemKind: string;
  itemId: string;
  title: string;
  state: string;
  classifier: string | null;
  confidence: number | null;
  lastError: string | null;
  status: string | null;
}
export type GroupPage =
  | { kind: "items"; items: GroupItem[]; nextCursor: string | null }
  | { kind: "concepts"; concepts: OutlineConcept[]; nextCursor: string | null };

export interface ConceptHeader {
  id: string;
  key: string;
  label: string;
  retired: boolean;
  domain: { id: string; label: string } | null;
  domainState: string;
  domainClassifier: string | null;
  domainConfidence: number | null;
  pinned: string[];
  aliases: string[];
  counts: { surfaces: number; decisions: number; references: number };
}
export interface ConceptDecision {
  id: string;
  scopeKind: string;
  scopeRef: string;
  scopeLabel: string;
  status: string;
  origin: string;
  constraintKind: string | null;
  decisionType: string;
  impact: number;
  version: number;
  reviewAt: string | null;
  ruleText: string | null;
  via: "primary" | "reference";
  placement: { state: string | null; classifier: string | null; confidence: number | null };
}
export interface ConceptConflict {
  id: string;
  kind: string;
  surface: string;
  openedAt: string;
  constraintKind: string | null;
  constraint: { id: string; ruleText: string | null };
  engineering: { id: string; ruleText: string | null } | null;
}
export interface ConceptContract {
  id: string;
  surface: string;
  kind: string;
  repo: { id: string; gitRemote: string | null };
  returnType: string | null;
  placement: { state: string; classifier: string | null };
  consumers: { count: number; sample: string[] };
  /** Binding rules only: this surface's, or its whole repository's. */
  governing: Array<{ id: string; status: string; origin: string; ruleText: string | null; via: string }>;
  /** Proposals, open, superseded or expired decisions — context, not authority. */
  related: Array<{ id: string; status: string; origin: string; ruleText: string | null; via: string }>;
  historyCount: number;
}
export interface ConceptSources {
  documents: Array<{
    id: string;
    title: string | null;
    url: string | null;
    state: string;
    tool: string;
    constraints: number;
  }>;
  provenances: Array<{ source: string; url: string | null; externalId: string | null; decisionId: string }>;
}
export interface SurfaceChange {
  id: string;
  version: number;
  delta: unknown;
  verifiedAgainst: string | null;
  verificationStatus: string;
  createdAt: string;
}

export type InboxKind =
  | "conflict"
  | "proposal"
  | "ratification"
  | "question"
  | "task"
  | "review_due"
  | "placement"
  | "check_finding"
  | "exception_request"
  | "rollout_failure";
export interface InboxItem {
  kind: InboxKind;
  id: string;
  severity: 0 | 1 | 2 | 3;
  score: number;
  title: string;
  detail: string | null;
  impact: number;
  createdAt: string;
  conceptId: string | null;
  conceptLabel: string | null;
  meta: Record<string, unknown>;
}
export interface Inbox {
  items: InboxItem[];
  counts: Partial<Record<InboxKind, number>>;
  housekeeping: number;
  viewer: { role: string };
  nextCursor: string | null;
}

export interface ConceptSettings {
  domains: Array<{ id: string; key: string; label: string; position: number; concepts: number }>;
  httpRules: { skip: string[]; isDefault: boolean; defaults: string[] };
  ruleVersion: number;
  rebuild: {
    phase: string | null;
    startedAt?: string;
    finishedAt?: string | null;
    total?: number;
    satisfied?: number;
    queued: boolean;
  };
  queue: { pending: number; noProvider: number; failed: number };
  providers: { jev: boolean; claude: boolean };
}

export interface SearchResult {
  concepts: Array<{ id: string; label: string; key: string }>;
  surfaces: Array<{ id: string; surface: string; conceptId: string | null }>;
  decisions: Array<{ id: string; ruleText: string; status: string; conceptId: string | null }>;
  /** Org catalog matches (Standards & Skills), when enabled. */
  standards?: Array<{ id: string; kind: string; name: string; slug: string }>;
}

export interface GraphData {
  nodes: Array<
    | {
        id: string;
        kind: "domain";
        label: string;
        count: number;
        decisions: number;
        conflicts: number;
        expanded: boolean;
      }
    | {
        id: string;
        kind: "concept";
        label: string;
        key: string;
        count: number;
        decisions: number;
        conflicts: number;
        expanded: boolean;
        parent: string;
      }
    | { id: string; kind: "item"; label: string; status: string; origin: string; conflict: boolean; parent: string }
  >;
  edges: Array<{ from: string; to: string; kind: "shared_decision" | "conflict"; weight: number }>;
  truncated: boolean;
  nextCursor: string | null;
}

export type LedgerTab = "decisions" | "contracts" | "sources" | "questions" | "tasks";
export interface LedgerPage<T> {
  rows: T[];
  nextCursor: string | null;
}
type ConceptRef = { id: string; label: string; key: string } | null;
export interface LedgerDecision {
  id: string;
  created_at: string;
  scope_kind: string;
  scope_ref: string;
  scope_label: string;
  status: string;
  origin: string;
  decision_type: string;
  constraint_kind: string | null;
  impact: number;
  current_version: number;
  rule_text: string | null;
  concept: ConceptRef;
}
export interface LedgerContract {
  id: string;
  surface: string;
  kind: string;
  git_remote: string | null;
  consumers: number;
  governing: number;
  changes: number;
  concept: ConceptRef;
}
export interface LedgerSource {
  id: string;
  title: string | null;
  url: string | null;
  tool: string;
  state: string;
  created_at: string;
  constraints: number;
}
export interface LedgerQuestion {
  id: string;
  body: string;
  status: string;
  urgent: boolean;
  scope_ref: string | null;
  created_at: string;
  answers: number;
}
export interface LedgerTask {
  id: string;
  title: string;
  status: string;
  run_state: string;
  created_at: string;
  delegated_to: string | null;
}

export const getOutline = (o: string, p: string) => apiGet<Outline>(`${P(o, p)}/outline`);
export const getOutlineDomain = (o: string, p: string, domainId: string, cursor?: string) =>
  apiGet<{ concepts: OutlineConcept[]; nextCursor: string | null }>(
    `${P(o, p)}/outline/domains/${domainId}${qs({ cursor })}`,
  );
export const getOutlineGroup = (o: string, p: string, group: string, cursor?: string) =>
  apiGet<GroupPage>(`${P(o, p)}/outline/groups/${group}${qs({ cursor })}`);
export const getConcept = (o: string, p: string, id: string) => apiGet<ConceptHeader>(`${P(o, p)}/concepts/${id}`);
export const getConceptDecisions = (o: string, p: string, id: string, cursor?: string) =>
  apiGet<{ conflicts: ConceptConflict[]; decisions: ConceptDecision[]; nextCursor: string | null }>(
    `${P(o, p)}/concepts/${id}${qs({ tab: "decisions", cursor })}`,
  );
export const getConceptContracts = (o: string, p: string, id: string, cursor?: string) =>
  apiGet<{ contracts: ConceptContract[]; nextCursor: string | null; projectWideBinding?: number }>(
    `${P(o, p)}/concepts/${id}${qs({ tab: "contracts", cursor })}`,
  );
export const getConceptSources = (o: string, p: string, id: string) =>
  apiGet<ConceptSources>(`${P(o, p)}/concepts/${id}${qs({ tab: "sources" })}`);
export const getSurfaceHistory = (o: string, p: string, id: string, cursor?: string) =>
  apiGet<{ history: SurfaceChange[]; nextCursor: string | null }>(`${P(o, p)}/surfaces/${id}/history${qs({ cursor })}`);
export const getInbox = (
  o: string,
  p: string,
  opts: { cursor?: string; kinds?: string; housekeeping?: boolean } = {},
) =>
  apiGet<Inbox>(
    `${P(o, p)}/inbox${qs({ cursor: opts.cursor, kinds: opts.kinds, housekeeping: opts.housekeeping ? "1" : undefined })}`,
  );
export const getLedger = <T>(o: string, p: string, tab: LedgerTab, opts: Record<string, string | undefined> = {}) =>
  apiGet<LedgerPage<T>>(`${P(o, p)}/ledger/${tab}${qs(opts)}`);
export const getConceptSettings = (o: string, p: string) => apiGet<ConceptSettings>(`${P(o, p)}/concepts-settings`);
export const searchProject = (o: string, p: string, q: string) => apiGet<SearchResult>(`${P(o, p)}/search${qs({ q })}`);
export const getConceptGraph = (o: string, p: string, expand?: string, cursor?: string, focus?: string) =>
  apiGet<GraphData>(`${P(o, p)}/graph/concepts${qs({ expand, cursor, focus })}`);

/* ── approval brief (decision review) ── */
export interface DecisionBrief {
  id: string;
  scopeKind: string;
  scopeRef: string;
  decisionType: string;
  status: string;
  origin: string;
  impact: number;
  currentVersion: number;
  constraintKind: string | null;
  expiresAt: string | null;
  reviewAt: string | null;
  createdAt: string;
  ruleText: string;
  rationale: string | null;
  alternatives: string[] | null;
  proposedBy: string | null;
  versions: Array<{ version: number; ruleText: string; status: string; proposedBy: string | null; createdAt: string }>;
  approvals: Array<{
    version: number;
    reviewer: string | null;
    verdict: string;
    comment: string | null;
    createdAt: string;
  }>;
  provenances: Array<{
    source: string;
    url: string | null;
    evidence: Array<{ quote: string }> | null;
    confidence: number | null;
  }>;
  consumers: Array<{
    repoId: string;
    gitRemote: string | null;
    project: { id: string; name: string } | null;
    source: string;
  }>;
  lineage: {
    supersedes: Array<{ id: string; ruleText: string; status: string }>;
    supersededBy: { id: string; ruleText: string; status: string } | null;
  };
  raisedFrom: {
    channel: "document" | "conversation" | "agent";
    document: { id: string; title: string | null; url: string | null; tool: string; state: string } | null;
    sources: Array<{
      source: string;
      url: string | null;
      externalId: string | null;
      anchor: Record<string, unknown> | null;
      anchorStatus: string;
      at: string;
    }>;
    decidedBy: string | null;
    extractor: string | null;
  };
  concept: {
    id: string;
    label: string;
    key: string;
    domain: string | null;
    state: string;
    classifier: string | null;
  } | null;
  placement: { location: string; state: string } | null;
  conflictsDetail: Array<{
    id: string;
    kind: string;
    status: string;
    surface: string;
    openedAt: string;
    side: "constraint" | "engineering";
    other: { id: string; ruleText: string | null; status: string | null; origin: string | null } | null;
  }>;
  neighbours: Array<{
    id: string;
    status: string;
    origin: string;
    scopeRef: string;
    ruleText: string | null;
    sameScope: boolean;
  }>;
  supersedesHint: { id: string; status: string; ruleText: string | null } | null;
  summary: { text: string; model: string } | null;
  writeback: {
    target: { tool: string; label: string } | null;
    history: Array<{ tool: string; verdict: string; status: string; postedAt: string | null; at: string }>;
  };
}
export const getDecisionBrief = (o: string, p: string, id: string) =>
  apiGet<DecisionBrief>(`${P(o, p)}/decisions/${id}/brief`);
