import { and, desc, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  decisions,
  decisionVersions,
  decisionApprovals,
  dependencyEdges,
  changeFeedEntries,
  contracts,
  questions,
  answers,
  tasks,
  members,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { fanoutChangeTx, fanoutToProjectTx } from "../routing/routing-engine.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

const SHARED_SCOPES = new Set(["shared", "contract"]);

export interface ProposeInput {
  projectId: string;
  memberId: string;
  scopeKind: string; // surface | repo | topic | project | shared | contract
  scopeRef: string;
  ruleText: string;
  baseVersion: number; // CAS: must equal the decision's current version (0 for new)
  provenance?: unknown;
}

/**
 * Propose a decision with optimistic concurrency. New version only commits if
 * baseVersion matches the decision's current version, else 409 (caller re-bases).
 * Owner-scoped → binding immediately; shared/contract → open until acked.
 */
export async function proposeDecision(
  orgId: string,
  input: ProposeInput,
): Promise<{ decisionId: string; version: number; status: string }> {
  return withOrg(orgId, async (tx: Tx) => {
    const existing = (
      await tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.projectId, input.projectId),
            eq(decisions.scopeKind, input.scopeKind),
            eq(decisions.scopeRef, input.scopeRef),
          ),
        )
        .limit(1)
    )[0];

    const shared = SHARED_SCOPES.has(input.scopeKind);
    let decisionId: string;
    let currentVersion: number;

    if (!existing) {
      if (input.baseVersion !== 0) throw conflict(`stale base_version: expected 0, got ${input.baseVersion}`);
      const d = one(
        await tx
          .insert(decisions)
          .values({
            orgId,
            projectId: input.projectId,
            scopeKind: input.scopeKind,
            scopeRef: input.scopeRef,
            currentVersion: 0,
            status: "open",
          })
          .returning(),
      );
      decisionId = d.id;
      currentVersion = 0;
    } else {
      if (existing.currentVersion !== input.baseVersion) {
        throw conflict(`stale base_version: current is ${existing.currentVersion}, got ${input.baseVersion}`);
      }
      decisionId = existing.id;
      currentVersion = existing.currentVersion;
    }

    const version = currentVersion + 1;
    const status = shared ? "open" : "binding";
    await tx.insert(decisionVersions).values({
      orgId,
      decisionId,
      version,
      baseVersion: input.baseVersion,
      ruleText: input.ruleText,
      provenance: input.provenance ?? null,
      status,
      proposedBy: input.memberId,
    });
    await tx.update(decisions).set({ currentVersion: version, status }).where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "decision.proposed",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { scopeKind: input.scopeKind, scopeRef: input.scopeRef, status },
    });
    // Fan out shared decisions to all project members so they see it in their inbox
    if (shared) {
      await fanoutToProjectTx(tx, orgId, {
        projectId: input.projectId,
        refId: decisionId,
        kind: "decision",
        senderMemberId: input.memberId,
        reason: { scopeRef: input.scopeRef, ruleText: input.ruleText },
      });
    }
    return { decisionId, version, status };
  });
}

/** Ack/review a shared decision; an approval promotes it to binding (v1: first ack binds). */
export async function ackDecision(
  orgId: string,
  decisionId: string,
  version: number,
  memberId: string,
  verdict = "ack",
): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    await tx.insert(decisionApprovals).values({ orgId, decisionId, version, reviewerId: memberId, verdict });
    let status = d.status;
    if ((verdict === "ack" || verdict === "approve") && d.status === "open") {
      status = "binding";
      await tx.update(decisions).set({ status }).where(eq(decisions.id, decisionId));
    }
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "decision.acked",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { verdict, status },
    });
    return { status };
  });
}

export async function listDecisions(
  orgId: string,
  projectId: string,
  scopeRef?: string,
): Promise<
  Array<{ id: string; scopeKind: string; scopeRef: string; status: string; version: number; ruleText: string }>
> {
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    const out = [];
    for (const d of ds) {
      if (scopeRef && d.scopeRef !== scopeRef) continue;
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      out.push({
        id: d.id,
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        status: d.status,
        version: d.currentVersion,
        ruleText: v?.ruleText ?? "",
      });
    }
    return out;
  });
}

export async function registerDependency(
  orgId: string,
  input: {
    projectId: string;
    memberId: string;
    consumerRepoId: string;
    producedSurface: string;
    producedRepoId?: string | null;
    source?: string;
  },
): Promise<{ edgeId: string }> {
  return withOrg(orgId, async (tx) => {
    const edge = one(
      await tx
        .insert(dependencyEdges)
        .values({
          orgId,
          projectId: input.projectId,
          consumerRepoId: input.consumerRepoId,
          producedRepoId: input.producedRepoId ?? null,
          producedSurface: input.producedSurface,
          source: input.source ?? "register_dependency",
          createdBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "dependency.registered",
      entityKind: "dependency_edge",
      entityId: edge.id,
      payload: { consumerRepoId: input.consumerRepoId, producedSurface: input.producedSurface },
    });
    return { edgeId: edge.id };
  });
}

export interface NotifyInput {
  projectId: string;
  repoId: string;
  memberId: string;
  summary: string;
  surface?: string;
  contractDelta?: unknown;
  riskTier?: string; // owned | shared | contract
  verified?: boolean;
  verifiedAgainst?: string;
  diffHash?: string;
}

/** Record a change-feed entry (+ contract if a delta is supplied). Routing happens in P5. */
export async function recordChange(
  orgId: string,
  input: NotifyInput,
): Promise<{ changeId: string; publishState: string; delivered: number }> {
  const riskTier = input.riskTier ?? "owned";
  const publishState = riskTier === "owned" ? "published" : "pending_confirm";
  return withOrg(orgId, async (tx) => {
    let contractId: string | null = null;
    if (input.contractDelta !== undefined && input.surface) {
      const c = one(
        await tx
          .insert(contracts)
          .values({
            orgId,
            repoId: input.repoId,
            surface: input.surface,
            delta: input.contractDelta ?? null,
            verified: input.verified ?? false,
            verifiedAgainst: input.verifiedAgainst ?? null,
            verificationStatus: input.verified ? "verified" : "asserted_unverified",
            createdBy: input.memberId,
          })
          .returning(),
      );
      contractId = c.id;
    }
    const change = one(
      await tx
        .insert(changeFeedEntries)
        .values({
          orgId,
          projectId: input.projectId,
          repoId: input.repoId,
          summary: input.summary,
          contractId,
          surface: input.surface ?? null,
          riskTier,
          publishState,
          diffHash: input.diffHash ?? null,
          createdBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "change.published",
      entityKind: "change_feed_entry",
      entityId: change.id,
      payload: { surface: input.surface, riskTier, publishState },
    });

    // Route to consumers of the changed surface (dependency-graph fan-out).
    let delivered = 0;
    if (input.surface) {
      delivered = await fanoutChangeTx(tx, orgId, {
        projectId: input.projectId,
        changeId: change.id,
        surface: input.surface,
        senderRepoId: input.repoId,
        senderMemberId: input.memberId,
      });
    }
    return { changeId: change.id, publishState, delivered };
  });
}

/* ───────────────────────────── Questions ───────────────────────────── */

export async function askQuestion(
  orgId: string,
  input: { projectId: string; memberId: string; body: string; scopeRef?: string; urgent?: boolean },
): Promise<{ questionId: string; status: string }> {
  return withOrg(orgId, async (tx) => {
    const q = one(
      await tx
        .insert(questions)
        .values({
          orgId,
          projectId: input.projectId,
          scopeKind: input.scopeRef ? "surface" : "project",
          scopeRef: input.scopeRef ?? null,
          body: input.body,
          urgent: input.urgent ?? false,
          askedBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "question.asked",
      entityKind: "question",
      entityId: q.id,
    });
    await fanoutToProjectTx(tx, orgId, {
      projectId: input.projectId,
      refId: q.id,
      kind: "question",
      senderMemberId: input.memberId,
      reason: { body: input.body, scopeRef: input.scopeRef ?? null, urgent: input.urgent ?? false },
    });
    return { questionId: q.id, status: q.status };
  });
}

export async function answerQuestion(
  orgId: string,
  questionId: string,
  memberId: string,
  response: string,
): Promise<{ answerId: string; status: string }> {
  return withOrg(orgId, async (tx) => {
    const q = (await tx.select().from(questions).where(eq(questions.id, questionId)).limit(1))[0];
    if (!q) throw Object.assign(new Error("question not found"), { statusCode: 404 });
    const ans = one(
      await tx.insert(answers).values({ orgId, questionId, body: response, answeredBy: memberId }).returning(),
    );
    await tx.update(questions).set({ status: "answered" }).where(eq(questions.id, questionId));
    await writeAudit(tx, {
      orgId,
      projectId: q.projectId,
      actorMemberId: memberId,
      action: "question.answered",
      entityKind: "question",
      entityId: questionId,
    });
    return { answerId: ans.id, status: "answered" };
  });
}

/* ───────────────────────────── Tasks ───────────────────────────── */

export async function createTask(
  orgId: string,
  input: { projectId: string; memberId: string; title: string; to?: string; refs?: unknown },
): Promise<{ taskId: string; runState: string }> {
  return withOrg(orgId, async (tx) => {
    let delegatedTo: string | null = null;
    if (input.to) {
      const m = (
        await tx
          .select()
          .from(members)
          .where(and(eq(members.orgId, orgId), eq(members.githubLogin, input.to)))
          .limit(1)
      )[0];
      delegatedTo = m?.id ?? null;
    }
    const t = one(
      await tx
        .insert(tasks)
        .values({
          orgId,
          projectId: input.projectId,
          title: input.title,
          refs: input.refs ?? null,
          delegatedBy: input.memberId,
          delegatedTo,
          approver: delegatedTo,
          runState: "queued",
          status: "open",
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "task.delegated",
      entityKind: "task",
      entityId: t.id,
    });
    await fanoutToProjectTx(tx, orgId, {
      projectId: input.projectId,
      refId: t.id,
      kind: "task",
      senderMemberId: input.memberId,
      targetMemberId: delegatedTo,
      reason: { title: input.title, to: input.to ?? null },
    });
    return { taskId: t.id, runState: t.runState };
  });
}

export async function completeTask(orgId: string, taskId: string, memberId: string): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const t = (await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
    if (!t) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    await tx.update(tasks).set({ runState: "done", status: "closed" }).where(eq(tasks.id, taskId));
    await writeAudit(tx, {
      orgId,
      projectId: t.projectId,
      actorMemberId: memberId,
      action: "task.completed",
      entityKind: "task",
      entityId: taskId,
    });
    return { status: "done" };
  });
}

/* ───────────────────────────── Tier-2 reconcile (the hard gate) ───────────────────────────── */

/**
 * Reconcile a set of changed contract surfaces against the ledger. A contract change
 * with no binding decision is a violation (PR check fails). Also surfaces stale dependents.
 */
export async function reconcile(
  orgId: string,
  projectId: string,
  contractSurfaces: string[],
): Promise<{ ok: boolean; violations: string[]; staleDependents: Array<{ surface: string; consumers: string[] }> }> {
  return withOrg(orgId, async (tx) => {
    const violations: string[] = [];
    const staleDependents: Array<{ surface: string; consumers: string[] }> = [];
    for (const surface of contractSurfaces) {
      const d = (
        await tx
          .select()
          .from(decisions)
          .where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, surface)))
          .limit(1)
      )[0];
      if (!d || d.status !== "binding") violations.push(surface);
      const deps = await tx
        .select()
        .from(dependencyEdges)
        .where(and(eq(dependencyEdges.producedSurface, surface), eq(dependencyEdges.active, true)));
      if (deps.length > 0) {
        staleDependents.push({ surface, consumers: [...new Set(deps.map((e) => e.consumerRepoId))] });
      }
    }
    return { ok: violations.length === 0, violations, staleDependents };
  });
}

/** Retrieval for query(): the agent synthesizes the answer; the core only returns rows. */
export async function queryLedger(
  orgId: string,
  projectId: string,
  q: string,
): Promise<{ decisions: unknown[]; changes: unknown[]; answeredQuestions: unknown[] }> {
  const needle = q.toLowerCase();
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    const decRows = [];
    for (const d of ds) {
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      const hay = `${d.scopeRef} ${v?.ruleText ?? ""}`.toLowerCase();
      if (hay.includes(needle)) decRows.push({ scopeRef: d.scopeRef, status: d.status, ruleText: v?.ruleText ?? "" });
    }
    const changes = (
      await tx
        .select()
        .from(changeFeedEntries)
        .where(eq(changeFeedEntries.projectId, projectId))
        .orderBy(desc(changeFeedEntries.createdAt))
        .limit(20)
    ).filter((c) => `${c.summary} ${c.surface ?? ""}`.toLowerCase().includes(needle));
    const answeredQuestions = (
      await tx
        .select()
        .from(questions)
        .where(and(eq(questions.projectId, projectId), eq(questions.status, "answered")))
    ).filter((qq) => qq.body.toLowerCase().includes(needle));
    return { decisions: decRows, changes, answeredQuestions };
  });
}
