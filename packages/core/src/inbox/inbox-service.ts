import { and, eq, inArray } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import {
  inboxes,
  inboxItems,
  changeFeedEntries,
  questions,
  tasks,
  decisions,
  decisionVersions,
  repos,
  members,
} from "../db/schema.js";
import { withSystem } from "../db/rls.js";

export interface InboxView {
  unread: number;
  changes: Array<{ id: string; summary: string; surface: string | null; riskTier: string }>;
  questions: Array<{ id: string; body: string; scopeRef: string | null; urgent: boolean; status: string }>;
  tasks: Array<{ id: string; title: string; runState: string; status: string }>;
  decisions: Array<{ id: string; scopeRef: string; ruleText: string; status: string }>;
}

/**
 * Read a session's inbox — return unread items WITHOUT marking them as read.
 * Items stay unread until explicitly acknowledged via ackInbox.
 */
export async function readInbox(
  orgId: string,
  ctx: { memberId: string; repoId: string; projectId: string },
): Promise<InboxView> {
  return withOrg(orgId, async (tx) => {
    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, ctx.memberId), eq(inboxes.repoId, ctx.repoId), eq(inboxes.projectId, ctx.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { unread: 0, changes: [], questions: [], tasks: [], decisions: [] };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    const changeIds = items.filter((i) => i.kind === "change").map((i) => i.refId);
    const questionIds = items.filter((i) => i.kind === "question").map((i) => i.refId);
    const taskIds = items.filter((i) => i.kind === "task").map((i) => i.refId);
    const decisionIds = items.filter((i) => i.kind === "decision").map((i) => i.refId);

    const changeRows = changeIds.length
      ? await tx.select().from(changeFeedEntries).where(inArray(changeFeedEntries.id, changeIds))
      : [];

    const questionRows = questionIds.length
      ? await tx.select().from(questions).where(inArray(questions.id, questionIds))
      : [];

    const taskRows = taskIds.length ? await tx.select().from(tasks).where(inArray(tasks.id, taskIds)) : [];

    const decisionRows: Array<{ id: string; scopeRef: string; ruleText: string; status: string }> = [];
    if (decisionIds.length) {
      const ds = await tx.select().from(decisions).where(inArray(decisions.id, decisionIds));
      for (const d of ds) {
        const v = (
          await tx
            .select()
            .from(decisionVersions)
            .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
            .limit(1)
        )[0];
        decisionRows.push({ id: d.id, scopeRef: d.scopeRef, ruleText: v?.ruleText ?? "", status: d.status });
      }
    }

    return {
      unread: items.length,
      changes: changeRows.map((c) => ({ id: c.id, summary: c.summary, surface: c.surface, riskTier: c.riskTier })),
      questions: questionRows.map((q) => ({
        id: q.id,
        body: q.body,
        scopeRef: q.scopeRef,
        urgent: q.urgent,
        status: q.status,
      })),
      tasks: taskRows.map((t) => ({ id: t.id, title: t.title, runState: t.runState, status: t.status })),
      decisions: decisionRows,
    };
  });
}

/**
 * Acknowledge inbox items — mark them as read. Call this after the user has seen the messages.
 * If itemIds is empty, marks ALL unread items as read.
 */
export async function ackInbox(
  orgId: string,
  ctx: { memberId: string; repoId: string; projectId: string },
  itemIds?: string[],
): Promise<{ acknowledged: number }> {
  return withOrg(orgId, async (tx) => {
    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, ctx.memberId), eq(inboxes.repoId, ctx.repoId), eq(inboxes.projectId, ctx.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { acknowledged: 0 };

    if (itemIds && itemIds.length > 0) {
      const result = await tx
        .update(inboxItems)
        .set({ state: "read" })
        .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread"), inArray(inboxItems.refId, itemIds)))
        .returning();
      return { acknowledged: result.length };
    }

    const result = await tx
      .update(inboxItems)
      .set({ state: "read" })
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")))
      .returning();
    return { acknowledged: result.length };
  });
}

export interface InboxPeek {
  unread: number;
  questions: number;
  tasks: number;
  changes: number;
  decisions: number;
}

/**
 * Peek at a session's inbox — return unread counts without marking anything as read.
 * Used for mid-session "you have N new messages" notifications.
 */
export async function peekInbox(
  orgId: string,
  ctx: { memberId: string; repoId: string; projectId: string },
): Promise<InboxPeek> {
  return withOrg(orgId, async (tx) => {
    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, ctx.memberId), eq(inboxes.repoId, ctx.repoId), eq(inboxes.projectId, ctx.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0 };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    return {
      unread: items.length,
      questions: items.filter((i) => i.kind === "question").length,
      tasks: items.filter((i) => i.kind === "task").length,
      changes: items.filter((i) => i.kind === "change").length,
      decisions: items.filter((i) => i.kind === "decision").length,
    };
  });
}

/**
 * Peek inbox by principal + git remote — no session needed.
 * Resolves remote → repo → project → member → inbox, then returns unread counts.
 * Used by the status line which doesn't have a session ID.
 */
export async function peekInboxByRemote(
  principalId: string,
  gitRemote: string,
): Promise<InboxPeek> {
  return withSystem(async (tx) => {
    const repo = (await tx.select().from(repos).where(eq(repos.gitRemote, gitRemote)).limit(1))[0];
    if (!repo) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0 };

    const member = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, repo.orgId), eq(members.principalId, principalId)))
        .limit(1)
    )[0];
    if (!member) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0 };

    const inbox = (
      await tx
        .select()
        .from(inboxes)
        .where(
          and(eq(inboxes.memberId, member.id), eq(inboxes.repoId, repo.id), eq(inboxes.projectId, repo.projectId)),
        )
        .limit(1)
    )[0];
    if (!inbox) return { unread: 0, questions: 0, tasks: 0, changes: 0, decisions: 0 };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    return {
      unread: items.length,
      questions: items.filter((i) => i.kind === "question").length,
      tasks: items.filter((i) => i.kind === "task").length,
      changes: items.filter((i) => i.kind === "change").length,
      decisions: items.filter((i) => i.kind === "decision").length,
    };
  });
}
