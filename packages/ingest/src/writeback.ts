import type { LockstepClient, PendingWriteback } from "./client.js";
import type { DocumentConnector } from "./connectors/SourceConnector.js";
import {
  composeDigestBlocks,
  composeDriftBlocks,
  composeWeeklyBlocks,
  digestFallbackText,
  driftFallbackText,
  weeklyFallbackText,
  type DriftAlertPayload,
  type SlackDigestPayload,
  type WeeklyDigestPayload,
} from "./slack/digest.js";
import { sendDigest as defaultSendDigest } from "./slack/send.js";

/** Payload core composes for a conflict_comment write-back (reconcile-service). */
interface ConflictCommentPayload {
  conflictId: string;
  anchorBlockId: string | null;
  body: string;
}

/** The slice of LockstepClient the drain needs — lets tests pass a plain fake. */
type WritebackClient = Pick<LockstepClient, "getPendingWritebacks" | "markWritebackDone">;

export interface DrainOpts {
  /** Resolve the DocumentConnector for a row (null ⇒ can't post, report failure to core). */
  connectorFor: (row: PendingWriteback) => DocumentConnector | null;
  sendDigestFn?: typeof defaultSendDigest;
  slackBotToken?: string;
  log?: (m: string) => void;
}

/**
 * Drain core's write-back queue: conflict_comment → Notion page comment via the row's connector,
 * slack_digest → ratification DM via the bot token, drift_alert → informational conflict DM (also
 * via the bot token). Every row is acked with markWritebackDone — ok:false leaves it queued for
 * retry (core fails it after three attempts). Per-row errors never abort the drain.
 */
export async function drainWritebacks(
  client: WritebackClient,
  opts: DrainOpts,
): Promise<{ posted: number; failed: number }> {
  const log = opts.log ?? (() => {});
  const send = opts.sendDigestFn ?? defaultSendDigest;
  const rows = await client.getPendingWritebacks();
  let posted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      switch (row.kind) {
        case "conflict_comment": {
          const connector = opts.connectorFor(row);
          if (!connector) {
            log(`[writeback] ${row.id}: no connector for ${row.tool} — skipping`);
            await client.markWritebackDone(row.id, false);
            failed++;
            continue;
          }
          const p = row.payload as ConflictCommentPayload;
          const { commentRef } = await connector.writeComment(row.targetRef, p.body, p.anchorBlockId);
          await client.markWritebackDone(row.id, true, commentRef);
          posted++;
          break;
        }
        case "slack_digest": {
          // targetRef is the recipient's Slack user id.
          if (!opts.slackBotToken) {
            log(`[writeback] ${row.id}: SLACK_BOT_TOKEN not set — cannot send digest`);
            await client.markWritebackDone(row.id, false);
            failed++;
            continue;
          }
          const p = row.payload as SlackDigestPayload;
          const r = await send(opts.slackBotToken, row.targetRef, composeDigestBlocks(p), digestFallbackText(p));
          await client.markWritebackDone(row.id, r.ok, r.ts);
          if (r.ok) posted++;
          else failed++;
          break;
        }
        case "drift_alert": {
          // Informational conflict DM — targetRef is the constraint owner's Slack user id.
          if (!opts.slackBotToken) {
            log(`[writeback] ${row.id}: SLACK_BOT_TOKEN not set — cannot send drift alert`);
            await client.markWritebackDone(row.id, false);
            failed++;
            continue;
          }
          const p = row.payload as DriftAlertPayload;
          const r = await send(opts.slackBotToken, row.targetRef, composeDriftBlocks(p), driftFallbackText(p));
          await client.markWritebackDone(row.id, r.ok, r.ts);
          if (r.ok) posted++;
          else failed++;
          break;
        }
        case "weekly_digest": {
          // Per-project operator summary DM — targetRef is an owner/pm Slack user id.
          if (!opts.slackBotToken) {
            log(`[writeback] ${row.id}: SLACK_BOT_TOKEN not set — cannot send weekly digest`);
            await client.markWritebackDone(row.id, false);
            failed++;
            continue;
          }
          const p = row.payload as WeeklyDigestPayload;
          const r = await send(opts.slackBotToken, row.targetRef, composeWeeklyBlocks(p), weeklyFallbackText(p));
          await client.markWritebackDone(row.id, r.ok, r.ts);
          if (r.ok) posted++;
          else failed++;
          break;
        }
      }
    } catch (e) {
      log(`[writeback] ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      try {
        await client.markWritebackDone(row.id, false);
      } catch {
        // core unreachable — the row stays queued and the next drain retries it
      }
      failed++;
    }
  }
  return { posted, failed };
}
