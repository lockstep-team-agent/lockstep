import { and, eq, inArray } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { inboxes, inboxItems, changeFeedEntries } from "../db/schema.js";

export interface InboxView {
  unread: number;
  changes: Array<{ id: string; summary: string; surface: string | null; riskTier: string }>;
}

/**
 * Read a session's inbox (its (member, repo, project) queue): return unread change
 * items hydrated, then mark them read. Lazy reconciliation/cursor refinements land later.
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
    if (!inbox) return { unread: 0, changes: [] };

    const items = await tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));

    const changeIds = items.filter((i) => i.kind === "change").map((i) => i.refId);
    const changeRows = changeIds.length
      ? await tx.select().from(changeFeedEntries).where(inArray(changeFeedEntries.id, changeIds))
      : [];

    if (items.length > 0) {
      await tx
        .update(inboxItems)
        .set({ state: "read" })
        .where(and(eq(inboxItems.inboxId, inbox.id), eq(inboxItems.state, "unread")));
    }

    return {
      unread: items.length,
      changes: changeRows.map((c) => ({ id: c.id, summary: c.summary, surface: c.surface, riskTier: c.riskTier })),
    };
  });
}
