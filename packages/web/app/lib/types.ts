export interface Me {
  principal: { githubLogin: string };
  memberships: Array<{ orgId: string }>;
}

export interface OrgOverview {
  projects: Array<{ id: string; name: string }>;
  members: Array<{ id: string; githubLogin: string }>;
}

export interface ProjectOverview {
  decisions: Array<{ id: string; scopeKind: string; scopeRef: string; status: string; version: number; ruleText: string }>;
  questions: Array<{ id: string; body: string; status: string; scopeRef: string | null; urgent: boolean }>;
  tasks: Array<{ id: string; title: string; runState: string; status: string }>;
  repos: Array<{ id: string; gitRemote: string }>;
  dependencies: Array<{ id: string; consumerRepoId: string; producedRepoId: string | null; producedSurface: string; source: string }>;
  contracts: Array<{ id: string; repoId: string; surface: string; verified: boolean; verificationStatus: string; version: number }>;
  audit: Array<{ action: string; entityKind: string | null; createdAt: string }>;
}
