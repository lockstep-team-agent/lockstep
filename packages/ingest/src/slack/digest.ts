/**
 * Ratification digest — the Slack DM a PM gets when an approved PRD yields fresh constraint
 * candidates. Pure Block Kit assembly only; the network half lives in send.ts (coverage-excluded).
 * The payload shape is composed by core (document-service queueDigest) — mirror it exactly.
 */

export interface DigestCandidate {
  decisionId: string;
  ruleText: string;
  scopeRef: string;
  constraintKind: string | null;
  confidencePct: number; // 0..100
  anchorUrl: string | null; // deep link to the section in the PRD
  conflict: { engDecisionId: string; engRuleText: string; surface: string } | null;
}

export interface SlackDigestPayload {
  orgId: string;
  documentId: string;
  docTitle: string | null;
  docUrl: string | null;
  docState: string;
  candidates: DigestCandidate[];
}

/** 1️⃣…9️⃣ keycaps; digests past nine candidates fall back to plain numbering. */
function numberEmoji(i: number): string {
  return i < 9 ? `${i + 1}️⃣` : `${i + 1}.`;
}

/** Ratify / Edit / Reject all carry the same {orgId, decisionId} value — the interaction handler routes on action_id. */
function actionButtons(orgId: string, decisionId: string): unknown[] {
  const value = JSON.stringify({ orgId, decisionId });
  return [
    { type: "button", text: { type: "plain_text", text: "Ratify" }, style: "primary", action_id: "ratify", value },
    { type: "button", text: { type: "plain_text", text: "Edit" }, action_id: "edit", value },
    { type: "button", text: { type: "plain_text", text: "Reject" }, style: "danger", action_id: "reject", value },
  ];
}

export function composeDigestBlocks(payload: SlackDigestPayload): unknown[] {
  const title = payload.docTitle ?? "Untitled PRD";
  const titleText = payload.docUrl ? `<${payload.docUrl}|${title}>` : title;
  // "active" is the ledger's canonical state — humans see "Approved".
  const stateLabel = payload.docState === "active" ? "Approved" : payload.docState;
  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📋 ${titleText} is *${stateLabel}* — ${payload.candidates.length} constraint(s) await your ratification`,
      },
    },
  ];
  payload.candidates.forEach((c, i) => {
    if (i > 0) blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${numberEmoji(i)} "${c.ruleText}"` } });
    const meta = [`scope ${c.scopeRef}`, `confidence ${c.confidencePct}%`];
    if (c.anchorUrl) meta.push(`<${c.anchorUrl}|view in PRD ↗>`);
    if (c.constraintKind) meta.push(c.constraintKind);
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: meta.join(" · ") }] });
    if (c.conflict) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `⚠ may conflict with a binding decision on ${c.conflict.surface} — review both`,
          },
        ],
      });
    }
    blocks.push({ type: "actions", elements: actionButtons(payload.orgId, c.decisionId) });
  });
  return blocks;
}

/** Notification-tray fallback for clients that don't render blocks. */
export function digestFallbackText(payload: SlackDigestPayload): string {
  return `${payload.docTitle ?? "A PRD"}: ${payload.candidates.length} constraint(s) await your ratification`;
}

/**
 * Drift alert — the INFORMATIONAL Slack DM a constraint owner gets when an engineering decision
 * looks like it may conflict with their binding constraint on the same surface. Rule-vs-rule with
 * links both ways and a "review & resolve" pointer; deliberately NO action buttons (unlike the
 * ratification digest) — the human resolves it in Lockstep, not from the DM. Composed by core
 * (reconcile-service); mirror the shape exactly.
 */
export interface DriftAlertPayload {
  conflictId: string;
  surface: string;
  constraint: { ruleText: string; docTitle: string | null; docUrl: string | null };
  eng: { ruleText: string; author: string | null };
}

export function composeDriftBlocks(payload: DriftAlertPayload): unknown[] {
  const { surface, constraint, eng } = payload;
  // Link the constraint back to its source doc when we have a url; the title (or a placeholder) is
  // the link label. docUrl/docTitle/author are all defensively null-safe.
  const docLabel = constraint.docTitle ?? "source doc";
  const constraintDoc = constraint.docUrl ? ` <${constraint.docUrl}|${docLabel} ↗>` : "";
  const engAuthor = eng.author ? ` — ${eng.author}` : "";
  // Web url points at the dashboard where the human reviews & resolves; fall back to plain text.
  const webUrl = process.env.LOCKSTEP_WEB_URL;
  const resolveText = webUrl
    ? `<${webUrl}|Review & resolve in Lockstep>`
    : "Review & resolve in the Lockstep dashboard";
  return [
    { type: "section", text: { type: "mrkdwn", text: `⚠ Drift on \`${surface}\`` } },
    { type: "section", text: { type: "mrkdwn", text: `*Constraint:* "${constraint.ruleText}"${constraintDoc}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Engineering:* "${eng.ruleText}"${engAuthor}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: "may conflict — review both" }] },
    { type: "context", elements: [{ type: "mrkdwn", text: resolveText }] },
  ];
}

/** Notification-tray fallback for the drift alert. */
export function driftFallbackText(payload: DriftAlertPayload): string {
  return `Drift on ${payload.surface}: a constraint and an engineering decision may conflict — review both`;
}
