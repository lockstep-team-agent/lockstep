/* DB-backed verification of the ledger (CAS decisions, deps, changes, query). */
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos } from "../db/schema.js";
import {
  proposeDecision,
  ackDecision,
  listDecisions,
  registerDependency,
  recordChange,
  queryLedger,
} from "../ledger/ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
function statusCodeOf(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode;
}

async function main(): Promise<void> {
  const ids = await withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: "T" }).returning());
    const pr = one(await tx.insert(principals).values({ githubUserId: 1, githubLogin: "naman" }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pr.id, githubUserId: 1, githubLogin: "naman" })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "shopify", createdBy: m.id }).returning());
    const repo = one(
      await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: "github.com/x/order" }).returning(),
    );
    return { orgId: org.id, memberId: m.id, projectId: proj.id, repoId: repo.id };
  });

  const checks: Array<[string, boolean]> = [];
  const base = { projectId: ids.projectId, memberId: ids.memberId };

  const d1 = await proposeDecision(ids.orgId, {
    ...base,
    scopeKind: "shared",
    scopeRef: "POST /orders",
    ruleText: "orders need idempotencyKey",
    baseVersion: 0,
  });
  checks.push(["propose v1 → open", d1.version === 1 && d1.status === "open"]);

  let stale = false;
  try {
    await proposeDecision(ids.orgId, {
      ...base,
      scopeKind: "shared",
      scopeRef: "POST /orders",
      ruleText: "conflicting",
      baseVersion: 0,
    });
  } catch (e) {
    stale = statusCodeOf(e) === 409;
  }
  checks.push(["CAS rejects stale base_version (409)", stale]);

  const d2 = await proposeDecision(ids.orgId, {
    ...base,
    scopeKind: "shared",
    scopeRef: "POST /orders",
    ruleText: "orders need idempotencyKey v2",
    baseVersion: 1,
  });
  checks.push(["propose v2 with correct base → version 2", d2.version === 2]);

  const ack = await ackDecision(ids.orgId, d2.decisionId, 2, ids.memberId, "ack");
  checks.push(["ack promotes shared decision to binding", ack.status === "binding"]);

  const owned = await proposeDecision(ids.orgId, {
    ...base,
    scopeKind: "repo",
    scopeRef: "order-service",
    ruleText: "use UTC",
    baseVersion: 0,
  });
  checks.push(["owner-scoped decision binds immediately", owned.status === "binding"]);

  const list = await listDecisions(ids.orgId, ids.projectId);
  checks.push(["listDecisions returns both decisions", list.length === 2]);

  const dep = await registerDependency(ids.orgId, {
    ...base,
    consumerRepoId: ids.repoId,
    producedSurface: "POST /orders",
  });
  checks.push(["dependency edge registered", !!dep.edgeId]);

  const owedChange = await recordChange(ids.orgId, {
    ...base,
    repoId: ids.repoId,
    summary: "tweak",
    surface: "GET /orders",
    riskTier: "owned",
  });
  checks.push(["owned change → published", owedChange.publishState === "published"]);

  const sharedChange = await recordChange(ids.orgId, {
    ...base,
    repoId: ids.repoId,
    summary: "contract change",
    surface: "POST /orders",
    riskTier: "shared",
    contractDelta: { added: ["idempotencyKey"] },
    verified: true,
    verifiedAgainst: "ts:orders.ts",
  });
  checks.push(["shared change → pending_confirm", sharedChange.publishState === "pending_confirm"]);

  const q = await queryLedger(ids.orgId, ids.projectId, "idempotency");
  checks.push(["query() retrieves the matching decision", q.decisions.length >= 1]);

  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "✅" : "❌"} ${name}`);
    if (!pass) ok = false;
  }
  process.exit(ok ? 0 : 1);
}

void main();
