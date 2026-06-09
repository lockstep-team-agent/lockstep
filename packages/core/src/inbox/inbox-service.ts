import { and, eq, inArray } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { inboxes, inboxItems, changeFeedEntries, questions, tasks } from "../db/schema.js";

export interface InboxView {
  unread: number;
  changes: Array<{ id: string; summary: string; surface: string | null; riskTier: string }>;
  questions: Array<{ id: string; body: string; scopeRef: string | null; urgent: boolean; status: string }>;
  tasks: Array<{ id: string; title: string; runState: string; status: string }>;
}

/**
 * Read a session's inbox (its (member, repo, project) queue): return unread change,
 * question, and task items hydrated, then mark them read.
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
    if (!inbox) return { unread: 0, changes: [], questions: [], tasks: [] };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    const changeIds = items.filter((i) => i.kind === "change").map((i) => i.refId);
    const questionIds = items.filter((i) => i.kind === "question").map((i) => i.refId);
    const taskIds = items.filter((i) => i.kind === "task").map((i) => i.refId);

    const changeRows = changeIds.length
      ? await tx.select().from(changeFeedEntries).where(inArray(changeFeedEntries.id, changeIds))
      : [];

    const questionRows = questionIds.length
      ? await tx.select().from(questions).where(inArray(questions.id, questionIds))
      : [];

    const taskRows = taskIds.length ? await tx.select().from(tasks).where(inArray(tasks.id, taskIds)) : [];

    if (items.length > 0) {
      await tx
        .update(inboxItems)
        .set({ state: "read" })
        .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));
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
    };
  });
}

export interface InboxPeek {
  unread: number;
  questions: number;
  tasks: number;
  changes: number;
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
    if (!inbox) return { unread: 0, questions: 0, tasks: 0, changes: 0 };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    return {
      unread: items.length,
      questions: items.filter((i) => i.kind === "question").length,
      tasks: items.filter((i) => i.kind === "task").length,
      changes: items.filter((i) => i.kind === "change").length,
    };
  });
}
