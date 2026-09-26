/** Typed fetchers for the Organization workspace (Standards & Skills). Server-only. */
import { apiGet } from "./api";

export const standardsEnabled = (): boolean => process.env.LOCKSTEP_STANDARDS === "1";

export type Kind = "standard" | "skill" | "check";

export interface OrgMe {
  memberId: string;
  role: "owner" | "admin" | null;
  teams: Array<{ id: string; name: string }>;
}
export interface CatalogRow {
  id: string;
  kind: Kind;
  slug: string;
  name: string;
  archived: boolean;
  published: { id: string; version: number; publishedAt: string | null } | null;
  working: { id: string; version: number; state: string; updatedAt: string } | null;
}
export interface Requirement {
  key?: string;
  text: string;
  rationale: string;
  level: "required" | "recommended";
}
export interface VersionRow {
  id: string;
  itemId: string;
  version: number;
  state: "draft" | "proposed" | "published";
  content: Record<string, unknown>;
  packageId: string | null;
  provenance: Record<string, unknown> | null;
  authoredBy: string | null;
  proposedBy: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  updatedAt: string;
}
export interface ItemDetail {
  item: { id: string; kind: Kind; slug: string; name: string; archivedAt: string | null; ownerMemberId: string | null };
  versions: VersionRow[];
}
export interface PackageFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
  isScript: boolean;
}
export interface Preview {
  item: { id: string; kind: Kind; name: string; slug: string };
  version: { id: string; version: number; state: string; provenance: Record<string, unknown> | null; reviewHash: string };
  /** Every package file: text in full, binaries flagged. */
  fileTexts: Array<{ path: string; text: string | null; binary: boolean; unavailable?: boolean }>;
  content: Record<string, unknown>;
  brief: string | null;
  linked: Array<{ itemId: string; versionId: string; name: string; kind: string; version: number; state: string }>;
  package: { hash: string; totalBytes: number; files: PackageFile[]; declared: Record<string, unknown> | null } | null;
  skillMd: string | null;
  frontmatter: Record<string, string | string[]>;
  blockers: string[];
  verified: boolean | null;
}
export interface VersionDiff {
  from: { id: string; version: number };
  to: { id: string; version: number };
  fields: Array<{ field: string; from: unknown; to: unknown }>;
  requirements: Array<{ key: string; change: "added" | "removed" | "changed"; from?: Requirement; to?: Requirement }>;
  files: Array<{ path: string; change: string; diff?: Array<{ op: " " | "+" | "-"; line: string }> | null }>;
}
export interface RoleRow {
  memberId: string;
  role: "owner" | "admin" | null;
  login: string;
}
export interface TeamRow {
  id: string;
  slug: string;
  name: string;
  members: Array<{ teamId: string; memberId: string; login: string }>;
}
export interface ProjectStandards {
  repos: Array<{ id: string; gitRemote: string }>;
  assignments: Array<{
    assignmentId: string;
    name: string;
    revision: number;
    level: string;
    scope: {
      baseline: boolean;
      repos: string[];
      pathGlobs: string[];
      taskTypes: string[];
      audience: { kind: string; ids?: string[] };
      pilot: boolean;
    };
    items: Array<{
      itemId: string;
      versionId: string;
      kind: string;
      name: string;
      version: number;
      requirements?: Array<{ key: string; text: string; level: string }>;
    }>;
    exceptions: Array<{ id: string; requirementKey: string | null; versionId: string }>;
  }>;
}
export interface WhyApplies {
  standards: Array<{
    itemId: string;
    versionId: string;
    name: string;
    version: number;
    reasons: Reason[];
    requirements: Array<{ key: string; text: string; level: string; exempt: boolean }>;
  }>;
  skills: Array<{
    itemId: string;
    versionId: string;
    name: string;
    version: number;
    level: string;
    reasons: Reason[];
    exempt: boolean;
  }>;
  checks: Array<{ itemId: string; versionId: string; name: string; version: number; reasons: Reason[] }>;
  blocked: Array<{
    itemId: string;
    name: string;
    versions: Array<{ versionId: string; version: number; reasons: Reason[] }>;
  }>;
  unknown: Array<{ assignmentId: string; name: string; missing: string[] }>;
  limitations: string[];
}
export interface Reason {
  assignmentId: string;
  name: string;
  revision: number;
  matched: string[];
}

const O = (orgId: string) => `/orgs/${orgId}`;

export const getOrgMe = (orgId: string) => apiGet<OrgMe>(`${O(orgId)}/me`);
export const getCatalog = (orgId: string, kind?: Kind, archived = false) =>
  apiGet<{ items: CatalogRow[] }>(
    `${O(orgId)}/catalog?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(archived ? { archived: "1" } : {}) })}`,
  );
export const getItem = (orgId: string, itemId: string) => apiGet<ItemDetail>(`${O(orgId)}/catalog/items/${itemId}`);
export const getPreview = (orgId: string, versionId: string) =>
  apiGet<Preview>(`${O(orgId)}/catalog/versions/${versionId}/preview`);
export const getDiff = (orgId: string, from: string, to: string) =>
  apiGet<VersionDiff>(`${O(orgId)}/catalog/diff?${new URLSearchParams({ from, to })}`);
export const getRoles = (orgId: string) => apiGet<{ roles: RoleRow[] }>(`${O(orgId)}/roles`);
export const getTeams = (orgId: string) => apiGet<{ teams: TeamRow[] }>(`${O(orgId)}/teams`);
export const getProjectStandards = (orgId: string, projectId: string) =>
  apiGet<ProjectStandards>(`${O(orgId)}/projects/${projectId}/standards`);
export const getWhy = (orgId: string, projectId: string, q: { repoId?: string; taskType?: string; paths?: string }) =>
  apiGet<WhyApplies>(
    `${O(orgId)}/projects/${projectId}/standards/why?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as Array<[string, string]>)}`,
  );

/* ── Rollouts & Adoption (milestone 2) ── */

export interface SelectorsIn {
  projects?: string[];
  repos?: string[];
  pathGlobs?: string[];
  taskTypes?: string[];
  audience?: { kind: "all" } | { kind: "members" | "teams"; ids: string[] };
}
export interface ReleaseRow {
  id: string;
  name: string;
  items: Array<{ itemId: string; versionId: string; kind: string }>;
  withdrawn?: boolean | { reason: string } | null;
}
export interface AssignmentRow {
  id: string;
  name: string;
  state: "active" | "paused" | "retired";
  revision: number;
  level: "required" | "recommended" | null;
  selectors: SelectorsIn | null;
  pilot: SelectorsIn | null;
  release: (ReleaseRow & { withdrawn: boolean }) | null;
  createdAt: string;
}
export type EnvState =
  | "pending_sync"
  | "installed"
  | "outdated"
  | "failed"
  | "user_action_required"
  | "declined"
  | "exempt"
  | "unsupported"
  | "blocked"
  | "offered";
export interface Adoption {
  assignment: { id: string; name: string; state: string; revision: number };
  revisions: Array<{
    revision: number;
    reason: string;
    level: string;
    selectors: SelectorsIn;
    pilot: SelectorsIn | null;
    release: (ReleaseRow & { withdrawn: boolean }) | null;
    createdAt: string;
  }>;
  coverage: {
    reachableMembers: number;
    enrolledEnvironments: number;
    coveredMembers: number;
    membersNotEnrolled: number;
    guidanceEnvironments: number;
  };
  /** `stale`: last observed installed, but the checkout hasn't been in contact for 7+ days. */
  installation: Record<Exclude<EnvState, "offered"> | "stale", number>;
  sessionAvailability: { available: number; installed: number };
  invocation: string;
  outcomes: { results: number; completed: number; notEvaluated: number; possibleIssues: number; exempt: number };
  troubleshooting: Array<{ code: string; environments: number }>;
  rows: Array<{
    envId: string;
    login: string;
    repo: string | null;
    adapter: string;
    invocation: string;
    lastContactAt: string;
    fresh: boolean;
    skills: Array<{ itemId: string; name: string; version: number | null; state: EnvState; fresh: boolean; sessionAvailable: boolean; at: string | null }>;
    guidance: Array<{ name: string; version: number }>;
  }>;
  truncated: boolean;
}
export interface RolloutPreview {
  change: string;
  /** State fingerprint the preview was computed against; apply must present it. */
  basis: string;
  exceptionsNeedingReview?: Array<{ id: string; item: string; requirementKey: string | null; reason: string }>;
  environments: { total: number; affected: number; unsupported: number; notEnrolledMembers: number };
  totals: { install: number; update: number; remove: number };
  blocked: Array<{ name: string; versions: number[] }>;
  rows: Array<{
    envId: string;
    login: string;
    repo: string | null;
    adapter: string;
    supported: boolean;
    lastContactAt: string;
    changes: Array<{
      itemId: string;
      name: string;
      action: "install" | "update" | "remove";
      from?: number;
      to?: number;
    }>;
    blocked: string[];
  }>;
  truncated: boolean;
  timing: string;
}
export interface MyEnvironment {
  id: string;
  adapter: string;
  adapterVersion: string | null;
  projectId: string | null;
  repoId: string | null;
  lastContactAt: string;
  skills: Array<{
    itemId: string;
    name: string;
    version: number;
    level: string;
    state: EnvState;
    sessionAvailable: boolean;
  }>;
  offered: Array<{ slug: string; name: string; version: number }>;
  declined: Array<{ slug: string; name: string; level: string }>;
  blocked: Array<{ name: string; versions: number[] }>;
}

export const getAssignments = (orgId: string) =>
  apiGet<{ assignments: AssignmentRow[]; releases: ReleaseRow[] }>(`${O(orgId)}/assignments`);
export const getAdoption = (orgId: string, id: string) => apiGet<Adoption>(`${O(orgId)}/assignments/${id}/adoption`);
export const getMyEnvironments = (orgId: string) =>
  apiGet<{ environments: MyEnvironment[] }>(`${O(orgId)}/me/environments`);

/* ── Checks & exceptions (milestone 3) ── */

export type Execution = "completed" | "partial" | "skipped" | "unavailable" | "error";
export interface CheckFindingRow {
  key: string;
  requirementKey: string | null;
  criterion: string;
  verdict: "satisfied" | "possible_violation" | "inconclusive";
  evidence: Array<{ location: string; quote: string }>;
  note: string;
  action: { action: "dismiss" | "exception_requested"; rationale: string; exceptionId: string | null } | null;
}
export interface ArtifactCheck {
  id: string;
  name: string | null;
  artifactKind: "prd" | "code_diff";
  artifactRef: { documentId?: string; version?: number; title?: string; repoId?: string; files?: string[] };
  artifactHash: string;
  evaluator: string;
  execution: Execution;
  executionDetail: string | null;
  findings: CheckFindingRow[];
  releaseIds: string[];
  stale: false | string;
  createdAt: string;
}
export interface ExceptionRow {
  id: string;
  target: "requirement" | "skill_assignment";
  itemId: string;
  itemName: string;
  versionId: string;
  version: number | null;
  requirementKey: string | null;
  requirementText: string | null;
  scope: { projectId?: string; repoId?: string; taskType?: string; memberId?: string };
  reason: string;
  expiresAt: string | null;
  state: "requested" | "approved" | "rejected" | "expired" | "needs_review";
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}
export interface ProjectEnvironment {
  id: string;
  login: string;
  repo: string | null;
  adapter: string;
  lastContactAt: string;
  skills: number;
  installed: number;
  attention: number;
  blocked: number;
}

export const getProjectChecks = (orgId: string, projectId: string) =>
  apiGet<{ checks: ArtifactCheck[]; documents: Array<{ id: string; title: string; latestVersion: number | null }> }>(
    `${O(orgId)}/projects/${projectId}/standards/checks`,
  );
export const getExceptions = (orgId: string, projectId?: string) =>
  apiGet<{ exceptions: ExceptionRow[]; canDecide: boolean }>(
    `${O(orgId)}/exceptions${projectId ? `?projectId=${projectId}` : ""}`,
  );
export const getProjectEnvironments = (orgId: string, projectId: string) =>
  apiGet<{ environments: ProjectEnvironment[] }>(`${O(orgId)}/projects/${projectId}/standards/environments`);
