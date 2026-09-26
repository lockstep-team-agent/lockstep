export interface Me {
  principal: { githubLogin: string };
  memberships: Array<{ orgId: string }>;
}

export interface OrgOverview {
  org?: { id: string; name: string } | null;
  projects: Array<{ id: string; name: string; archived?: boolean; repos?: Array<{ id: string; gitRemote: string }> }>;
  members: Array<{ id: string; githubLogin: string }>;
}

export interface ProjectOverview {
  decisions: Array<{
    id: string;
    scopeKind: string;
    scopeRef: string;
    status: string;
    origin?: string;
    version: number;
    ruleText: string;
    decisionType?: string;
    // Phase J deliberation + lifecycle fields
    rationale?: string | null;
    alternatives?: string[] | null;
    reviewAt?: string | null;
    dueForReview?: boolean;
    supersededById?: string | null;
    supersedes?: string[];
    impact: number;
    createdAt: string;
    proposedBy: string | null;
  }>;
  questions: Array<{
    id: string;
    body: string;
    status: string;
    scopeRef: string | null;
    urgent: boolean;
    askedBy: string | null;
    createdAt: string;
    answer: { body: string; by: string | null; at: string } | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    runState: string;
    status: string;
    delegatedTo: string | null;
    delegatedBy: string | null;
    createdAt: string;
  }>;
  repos: Array<{ id: string; gitRemote: string }>;
  dependencies: Array<{
    id: string;
    consumerRepoId: string;
    producedRepoId: string | null;
    producedSurface: string;
    source: string;
    /** #4: set when the producer lives in another (shared) project. */
    producerProject?: { id: string; name: string } | null;
  }>;
  contracts: Array<{
    id: string;
    repoId: string;
    surface: string;
    verified: boolean;
    verifiedAgainst?: string | null;
    verificationStatus: string;
    version: number;
    consumerCount: number;
  }>;
  changes: Array<{
    id: string;
    surface: string | null;
    summary: string;
    riskTier: string;
    impact: number;
    createdBy: string | null;
    createdAt: string;
    repoId: string;
  }>;
  audit: Array<{
    action: string;
    entityKind: string | null;
    entityId: string | null;
    createdAt: string;
    actor: string | null;
    summary: string | null;
  }>;
  /* ── v3 product layer (optional — tolerate absence while core catches up) ── */
  viewer?: { memberId: string; role: "owner" | "pm" | "member" };
  members?: Array<{
    id: string;
    memberId: string | null;
    githubLogin: string;
    role: string;
    status: string;
    slackUserId?: string | null;
  }>;
  visibility?: "shared" | "walled";
  archived?: boolean;
  productLayer?: boolean;
  autoBind?: boolean;
}

export interface DecisionDetail {
  id: string;
  projectId: string;
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
  versions: Array<{
    version: number;
    baseVersion: number | null;
    ruleText: string;
    rationale: string | null;
    alternatives: string[] | null;
    status: string;
    proposedBy: string | null;
    createdAt: string;
  }>;
  approvals: Array<{
    version: number;
    reviewer: string | null;
    verdict: string;
    comment: string | null;
    createdAt: string;
  }>;
  requiredReviewers: Array<{ reviewer: string | null; required: boolean }>;
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
  sameSurfaceBinding: number;
  lineage: {
    supersedes: Array<{ id: string; ruleText: string; status: string }>;
    supersededBy: { id: string; ruleText: string; status: string } | null;
  };
  conflicts: Array<{ id: string; kind: string; status: string; surface: string }>;
}
