/**
 * Close the loop at the source: when a human ratifies, confirms or rejects a decision in Lockstep,
 * post it back where the rule came from — a page comment on the PRD (through that document's own
 * connector: Notion, Confluence, Google Docs…) or a reply in the Slack thread where it was agreed.
 *
 * Core only queues (writebacks table); the ingest worker delivers, exactly like conflict comments.
 * Agent-proposed decisions have no external source, so nothing is posted for them.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  decisionProvenances,
  decisions,
  decisionVersions,
  members,
  sourceDocuments,
  writebacks,
} from "../db/schema.js";
import { env } from "../env.js";

export type Verdict = "ratified" | "confirmed" | "rejected";

const DOC_TOOLS = new Set(["notion", "confluence", "gdocs"]);
const NOTE_MAX = 1000;

export interface VerdictTarget {
  tool: string; // notion | confluence | gdocs | slack
  kind: "decision_comment" | "slack_thread_reply";
  label: string; // human-readable: where the comment will land
  connectionId: string | null;
  targetRef: string;
  anchorBlockId: string | null;
}

/** Where a verdict on this decision would be posted, or null when there's nowhere to post it. */
export async function verdictTargetTx(tx: Tx, decisionId: string): Promise<VerdictTarget | null> {
  const v = (
    await tx
      .select({ provenance: decisionVersions.provenance })
      .from(decisionVersions)
      .where(eq(decisionVersions.decisionId, decisionId))
      .orderBy(desc(decisionVersions.version))
      .limit(1)
  )[0];
  const prov = (v?.provenance ?? {}) as { documentId?: unknown };
  if (typeof prov.documentId === "string") {
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, prov.documentId)).limit(1))[0];
    if (doc && doc.connectionId && DOC_TOOLS.has(doc.tool)) {
      const p = (
        await tx
          .select({ anchor: decisionProvenances.anchor })
          .from(decisionProvenances)
          .where(eq(decisionProvenances.decisionId, decisionId))
          .limit(1)
      )[0];
      const anchor = (p?.anchor ?? null) as { blockId?: string } | null;
      return {
        tool: doc.tool,
        kind: "decision_comment",
        label: `${doc.tool === "gdocs" ? "Google Docs" : doc.tool[0]!.toUpperCase() + doc.tool.slice(1)}: ${doc.title ?? "source document"}`,
        connectionId: doc.connectionId,
        targetRef: doc.externalId,
        anchorBlockId: anchor?.blockId ?? null,
      };
    }
  }
  // Slack units are keyed `${channel}/${threadTs}` (see ingest ComposioConnector.slackUnits).
  const slack = (
    await tx
      .select({ externalId: decisionProvenances.externalId })
      .from(decisionProvenances)
      .where(and(eq(decisionProvenances.decisionId, decisionId), eq(decisionProvenances.source, "slack")))
      .orderBy(decisionProvenances.createdAt)
      .limit(1)
  )[0];
  const m = slack?.externalId ? /^([^/]+)\/(\d+\.\d+)$/.exec(slack.externalId) : null;
  if (m) {
    return {
      tool: "slack",
      kind: "slack_thread_reply",
      label: "Slack: reply in the original thread",
      connectionId: null,
      targetRef: slack!.externalId!,
      anchorBlockId: null,
    };
  }
  return null;
}

export function composeVerdictText(i: {
  verdict: Verdict;
  login: string | null;
  ruleText: string;
  note?: string | null;
  link?: string | null;
}): string {
  const who = i.login ? `@${i.login}` : "a reviewer";
  const head =
    i.verdict === "rejected"
      ? `Rejected in Lockstep by ${who}: “${i.ruleText}” will not become a team rule.`
      : `${i.verdict === "ratified" ? "Ratified" : "Confirmed"} in Lockstep by ${who}: “${i.ruleText}” is now a binding rule — coding agents working on this area will follow it.`;
  return [head, i.note ? `Note: ${i.note}` : "", i.link ? `Details: ${i.link}` : ""].filter(Boolean).join("\n");
}

/**
 * Queue the source write-back for a verdict. Idempotent per (decision, verdict, version). Never
 * throws into the verdict: a write-back is a courtesy, not part of the decision's commit.
 */
export async function enqueueVerdictWriteback(
  orgId: string,
  decisionId: string,
  verdict: Verdict,
  memberId: string,
  note?: string | null,
): Promise<VerdictTarget | null> {
  try {
    return await withOrg(orgId, async (tx) => {
      const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
      if (!d) return null;
      const target = await verdictTargetTx(tx, decisionId);
      if (!target) return null;
      const v = (
        await tx
          .select({ ruleText: decisionVersions.ruleText })
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      const login =
        (await tx.select({ login: members.githubLogin }).from(members).where(eq(members.id, memberId)).limit(1))[0]
          ?.login ?? null;
      const web = env.LOCKSTEP_WEB_URL?.replace(/\/+$/, "");
      const text = composeVerdictText({
        verdict,
        login,
        ruleText: v?.ruleText ?? d.scopeRef,
        note: note?.trim().slice(0, NOTE_MAX) || null,
        link: web ? `${web}/project/${orgId}/${d.projectId}/decisions/${d.id}` : null,
      });
      const [channel, threadTs] = target.kind === "slack_thread_reply" ? target.targetRef.split("/") : [];
      await tx
        .insert(writebacks)
        .values({
          orgId,
          projectId: d.projectId,
          connectionId: target.connectionId,
          tool: target.tool,
          kind: target.kind,
          targetRef: target.targetRef,
          payload:
            target.kind === "slack_thread_reply"
              ? { decisionId, verdict, channel, threadTs, text }
              : { decisionId, verdict, anchorBlockId: target.anchorBlockId, body: text },
          dedupeKey: `verdict:${decisionId}:${verdict}:v${d.currentVersion}`,
        })
        .onConflictDoNothing();
      return target;
    });
  } catch (e) {
    console.error("[verdict-writeback] could not queue (verdict unaffected):", e);
    return null;
  }
}

/** What the brief shows: where a verdict would go, and what has already been posted. */
export async function verdictWritebacksTx(tx: Tx, decisionId: string) {
  const target = await verdictTargetTx(tx, decisionId);
  const posted = (await tx.execute(sql`
      SELECT tool, kind, status, payload->>'verdict' AS verdict, posted_at, created_at FROM writebacks
      WHERE payload->>'decisionId' = ${decisionId} AND kind IN ('decision_comment', 'slack_thread_reply')
      ORDER BY created_at DESC LIMIT 10`)) as unknown as Array<{
    tool: string;
    kind: string;
    status: string;
    verdict: string;
    posted_at: string | null;
    created_at: string;
  }>;
  return {
    target: target ? { tool: target.tool, label: target.label } : null,
    history: posted.map((p) => ({
      tool: p.tool,
      verdict: p.verdict,
      status: p.status,
      postedAt: p.posted_at,
      at: p.created_at,
    })),
  };
}
