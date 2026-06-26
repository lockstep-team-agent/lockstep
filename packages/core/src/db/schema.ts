/**
 * Lockstep system-of-record schema (PRD §9).
 *
 * Principles:
 *  - Multi-tenant: every child table carries `orgId`; Postgres RLS (see sql/0001_rls.sql)
 *    scopes every query to the caller's org. The `orgs` table is the tenant root.
 *  - Append-only / versioned / attributed: documents get new *version* rows rather than
 *    in-place mutation; narrow status columns are the only allowed UPDATEs (enforced by
 *    triggers in sql/0002_append_only.sql).
 *  - Source code never appears here — only coordination metadata.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
// org scoping column present on every child table (RLS key)
const orgId = () => uuid("org_id").notNull();

/* ───────────────────────────── Tenancy & identity ───────────────────────────── */

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  identityProvider: text("identity_provider").notNull().default("github"),
  retentionPolicy: jsonb("retention_policy"),
  deployment: text("deployment").notNull().default("self-host"), // cloud | self-host
  createdAt: createdAt(),
});

/**
 * Global identity (NOT org-scoped). A GitHub user is one principal that may be a
 * member of many orgs. principals/access_tokens/github_credentials are "system" tables —
 * RLS makes them readable only via the privileged withSystem() path (auth/login), never
 * by a normal tenant request.
 */
export const principals = pgTable("principals", {
  id: id(),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  displayName: text("display_name"),
  email: text("email"),
  createdAt: createdAt(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    orgId: orgId(),
    principalId: uuid("principal_id").notNull(),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(), // the @handle used in CODEOWNERS
    displayName: text("display_name"),
    email: text("email"),
    vendorsInUse: text("vendors_in_use").array(), // {claude,codex,gemini}
    createdAt: createdAt(),
  },
  (t) => ({
    uqOrgPrincipal: uniqueIndex("uq_members_org_principal").on(t.orgId, t.principalId),
    byLogin: index("ix_members_org_login").on(t.orgId, t.githubLogin),
  }),
);

export const projects = pgTable("projects", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  createdBy: uuid("created_by"),
});

export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    memberId: uuid("member_id"), // null until invite accepted
    invitedGithubLogin: text("invited_github_login").notNull(), // invite by handle
    role: text("role").notNull().default("member"), // owner | member
    status: text("status").notNull().default("invited"), // invited | active | revoked
    invitedBy: uuid("invited_by"),
    createdAt: createdAt(),
  },
  (t) => ({
    uqInvite: uniqueIndex("uq_project_member_login").on(t.projectId, t.invitedGithubLogin),
  }),
);

export const repos = pgTable(
  "repos",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    gitRemote: text("git_remote").notNull(), // canonical, e.g. github.com/org/order-service — match key
    defaultBranch: text("default_branch").default("main"),
    codeownersSha: text("codeowners_sha"),
    isMonorepo: boolean("is_monorepo").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    uqRemote: uniqueIndex("uq_repo_project_remote").on(t.projectId, t.gitRemote),
    byRemote: index("ix_repo_remote").on(t.gitRemote),
  }),
);

/* GitHub App installation per org (mint installation tokens for CODEOWNERS reads). */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: id(),
    orgId: orgId(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login"),
    createdAt: createdAt(),
  },
  (t) => ({ uqInstall: uniqueIndex("uq_install_org").on(t.orgId, t.installationId) }),
);

/* ───────────────────────────── Ownership graph ───────────────────────────── */

export const ownershipSnapshots = pgTable(
  "ownership_snapshots",
  {
    id: id(),
    orgId: orgId(),
    repoId: uuid("repo_id").notNull(),
    codeownersSha: text("codeowners_sha"),
    builtFrom: text("built_from").notNull().default("codeowners"), // codeowners | git_history | merged
    isCurrent: boolean("is_current").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({ byCurrent: index("ix_ownership_snapshot_current").on(t.repoId, t.isCurrent) }),
);

export const ownershipRules = pgTable(
  "ownership_rules",
  {
    id: id(),
    orgId: orgId(),
    repoId: uuid("repo_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    pattern: text("pattern").notNull(), // raw CODEOWNERS glob
    patternRegex: text("pattern_regex").notNull(), // precompiled
    precedence: integer("precedence").notNull(), // line order; last match wins
    source: text("source").notNull().default("codeowners"), // codeowners | git_history | manual_override
    createdAt: createdAt(),
  },
  (t) => ({ bySnapshot: index("ix_ownership_rule_snapshot").on(t.snapshotId, t.precedence) }),
);

export const ownershipRuleOwners = pgTable("ownership_rule_owners", {
  id: id(),
  orgId: orgId(),
  ruleId: uuid("rule_id").notNull(),
  ownerLogin: text("owner_login").notNull(), // @handle or @team
  memberId: uuid("member_id"), // resolved if known
});

/* ───────────────────────────── Decision docs (CAS, versioned) ───────────────────────────── */

export const decisions = pgTable("decisions", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  scopeKind: text("scope_kind").notNull(), // surface | repo | topic | project
  scopeRef: text("scope_ref").notNull(),
  // A decision is a durable RULE or ARCHITECTURAL choice that shapes future work — never a routine
  // change event (those live in change_feed_entries). See the product thesis.
  decisionType: text("decision_type").notNull().default("rule"), // rule | architecture
  // Blast radius, derived from the usage graph (count of consumers of the scope) with optional
  // agent/human override. Drives noise filtering, session-start ranking, and the binding model.
  impact: integer("impact").notNull().default(0),
  currentVersion: integer("current_version").notNull().default(0),
  status: text("status").notNull().default("open"), // open | ack | binding | superseded
  createdAt: createdAt(),
});

export const decisionVersions = pgTable(
  "decision_versions",
  {
    id: id(),
    orgId: orgId(),
    decisionId: uuid("decision_id").notNull(),
    version: integer("version").notNull(),
    baseVersion: integer("base_version").notNull(), // CAS target
    ruleText: text("rule_text").notNull(),
    provenance: jsonb("provenance"), // {source, vendor, gitSha, summary}
    status: text("status").notNull().default("open"),
    proposedBy: uuid("proposed_by"),
    createdAt: createdAt(),
  },
  (t) => ({ uqVersion: uniqueIndex("uq_decision_version").on(t.decisionId, t.version) }),
);

export const decisionRequiredReviewers = pgTable("decision_required_reviewers", {
  id: id(),
  orgId: orgId(),
  decisionId: uuid("decision_id").notNull(),
  reviewerMemberId: uuid("reviewer_member_id").notNull(),
  required: boolean("required").notNull().default(true),
});

export const decisionApprovals = pgTable("decision_approvals", {
  id: id(),
  orgId: orgId(),
  decisionId: uuid("decision_id").notNull(),
  version: integer("version").notNull(),
  reviewerId: uuid("reviewer_id").notNull(),
  verdict: text("verdict").notNull(), // approve | request_changes | ack
  comment: text("comment"),
  createdAt: createdAt(),
});

/* ───────────────────────────── Contract (asserted → verified) ───────────────────────────── */

export const contracts = pgTable(
  "contracts",
  {
    id: id(),
    orgId: orgId(),
    repoId: uuid("repo_id").notNull(),
    surface: text("surface").notNull(), // e.g. "POST /orders" — dependency-graph key
    delta: jsonb("delta"), // added/removed/changed fields & types
    verified: boolean("verified").notNull().default(false),
    verifiedAgainst: text("verified_against"), // "openapi:..." | "ts:..." | null
    verificationStatus: text("verification_status").notNull().default("asserted_unverified"),
    version: integer("version").notNull().default(1),
    decisionId: uuid("decision_id"),
    createdAt: createdAt(),
    createdBy: uuid("created_by"),
  },
  (t) => ({ bySurface: index("ix_contract_repo_surface").on(t.repoId, t.surface) }),
);

/* ───────────────────────────── Dependency graph (edge table) ───────────────────────────── */

export const dependencyEdges = pgTable(
  "dependency_edges",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id").notNull(),
    consumerRepoId: uuid("consumer_repo_id").notNull(),
    producedRepoId: uuid("produced_repo_id"), // nullable for cross-org/unknown producer
    producedSurface: text("produced_surface").notNull(), // "POST /orders"
    source: text("source").notNull().default("register_dependency"), // register_dependency | inferred
    active: boolean("active").notNull().default(true), // soft-delete / tombstone
    createdAt: createdAt(),
    createdBy: uuid("created_by"),
  },
  (t) => ({
    // the two hot routing queries:
    bySurface: index("ix_dep_surface_active").on(t.producedSurface, t.active),
    byProducer: index("ix_dep_producer_surface").on(t.producedRepoId, t.producedSurface),
  }),
);

/* ───────────────────────────── Question docs ───────────────────────────── */

export const questions = pgTable("questions", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  scopeKind: text("scope_kind").notNull(), // surface | repo | topic | project
  scopeRef: text("scope_ref"),
  body: text("body").notNull(),
  urgent: boolean("urgent").notNull().default(false),
  status: text("status").notNull().default("open"), // open | answered | closed
  routeTrace: jsonb("route_trace"),
  askedBy: uuid("asked_by"),
  createdAt: createdAt(),
});

export const answers = pgTable("answers", {
  id: id(),
  orgId: orgId(),
  questionId: uuid("question_id").notNull(),
  body: text("body").notNull(),
  answeredBy: uuid("answered_by"),
  writtenBackRef: uuid("written_back_ref"), // ledger row created so future query() finds it
  createdAt: createdAt(),
});

/* ───────────────────────────── Change feed ───────────────────────────── */

export const changeFeedEntries = pgTable("change_feed_entries", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  repoId: uuid("repo_id").notNull(),
  summary: text("summary").notNull(),
  contractId: uuid("contract_id"),
  surface: text("surface"),
  riskTier: text("risk_tier").notNull().default("owned"), // owned | shared | contract
  impact: integer("impact").notNull().default(0), // blast radius (consumer count of the surface)
  publishState: text("publish_state").notNull().default("drafted"), // drafted | pending_confirm | published
  provenance: jsonb("provenance"),
  diffHash: text("diff_hash"), // dedup key for PostToolUse vs Stop double-fire
  createdAt: createdAt(),
  createdBy: uuid("created_by"),
});

/* ───────────────────────────── Tasks ───────────────────────────── */

export const tasks = pgTable("tasks", {
  id: id(),
  orgId: orgId(),
  projectId: uuid("project_id").notNull(),
  title: text("title").notNull(),
  refs: jsonb("refs"),
  delegatedTo: uuid("delegated_to"),
  delegatedBy: uuid("delegated_by"),
  approver: uuid("approver"),
  runState: text("run_state").notNull().default("queued"), // queued | approved | running | done
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
});

/* ───────────────────────────── Inbox ───────────────────────────── */

export const inboxes = pgTable(
  "inboxes",
  {
    id: id(),
    orgId: orgId(),
    memberId: uuid("member_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    projectId: uuid("project_id").notNull(),
    replayCursor: uuid("replay_cursor"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uqInbox: uniqueIndex("uq_inbox_member_repo_project").on(t.memberId, t.repoId, t.projectId) }),
);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: id(),
    orgId: orgId(),
    inboxId: uuid("inbox_id").notNull(),
    kind: text("kind").notNull(), // change | decision | question | task
    refId: uuid("ref_id").notNull(),
    reason: jsonb("reason"), // route trace: why you got this
    state: text("state").notNull().default("unread"), // unread | read | acked
    createdAt: createdAt(),
  },
  (t) => ({ uqItem: uniqueIndex("uq_inbox_item").on(t.inboxId, t.kind, t.refId) }),
);

/* ───────────────────────────── Sessions ───────────────────────────── */

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    orgId: orgId(),
    memberId: uuid("member_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    projectId: uuid("project_id").notNull(),
    gitRemote: text("git_remote").notNull(),
    cwd: text("cwd"),
    vendor: text("vendor"), // claude | codex | gemini
    tokenId: uuid("token_id"),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).defaultNow().notNull(),
    state: text("state").notNull().default("live"), // live | ended
  },
  (t) => ({ byRepo: index("ix_session_repo_state").on(t.projectId, t.repoId, t.state) }),
);

/* ───────────────────────────── Auth ───────────────────────────── */

/* System table (principal-scoped, not org-scoped). */
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: id(),
    principalId: uuid("principal_id").notNull(),
    tokenHash: text("token_hash").notNull(), // sha256, never plaintext
    scopes: text("scopes").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ byHash: uniqueIndex("uq_token_hash").on(t.tokenHash) }),
);

/* user-to-server GitHub token (identity); installation tokens are minted on demand, not stored.
   System table (principal-scoped). */
export const githubCredentials = pgTable("github_credentials", {
  id: id(),
  principalId: uuid("principal_id").notNull(),
  accessTokenEnc: text("access_token_enc"), // encrypted at rest
  refreshTokenEnc: text("refresh_token_enc"),
  scopes: text("scopes").array(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

/* ───────────────────────────── Audit trail (append-only) ───────────────────────────── */

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid("project_id"),
    actorMemberId: uuid("actor_member_id"),
    action: text("action").notNull(), // decision.proposed | contract.verified | inbox.delivered | ...
    entityKind: text("entity_kind"),
    entityId: uuid("entity_id"),
    entityVersion: integer("entity_version"),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => ({ byEntity: index("ix_audit_entity").on(t.entityKind, t.entityId) }),
);
