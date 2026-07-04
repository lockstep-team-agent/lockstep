import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { withOrg, withSystem } from "../../db/rls.js";
import { members, decisions, decisionVersions } from "../../db/schema.js";
import { env } from "../../env.js";
import { verifySlackSignature } from "../../auth/slack-verify.js";
import { ratifyDecision, rejectDecision } from "../../ledger/ledger-service.js";

/**
 * Slack interactivity for the ratification digest (first-party Lockstep Slack app). The digest's
 * Ratify/Edit/Reject buttons and the Edit modal land here; the mutations are exactly the ones the
 * dashboard review queue calls — Slack and the dashboard are two frontends for one action.
 *
 * Slack posts application/x-www-form-urlencoded with a `payload` JSON field, signed over the RAW
 * body — so this plugin scope parses that content type as a string and verifies before parsing.
 */

interface SlackAction {
  orgId: string;
  decisionId: string;
}

/** Fire-and-forget ephemeral reply via response_url (Slack wants the HTTP 200 within 3s). */
function respondVia(responseUrl: string | undefined, text: string): void {
  if (!responseUrl) return;
  void fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, response_type: "ephemeral", replace_original: false }),
  }).catch(() => {});
}

async function memberForSlackUser(orgId: string, slackUserId: string): Promise<string | null> {
  return withSystem(async (tx) => {
    const m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.slackUserId, slackUserId)))
        .limit(1)
    )[0];
    return m?.id ?? null;
  });
}

async function currentRuleText(orgId: string, decisionId: string): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) return "";
    const v = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    return v?.ruleText ?? "";
  });
}

/** Open the Edit modal — the one place core talks to Slack directly (synchronous with the click). */
async function openEditModal(triggerId: string, action: SlackAction, ruleText: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;
  await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "lockstep_ratify_edit",
        private_metadata: JSON.stringify(action),
        title: { type: "plain_text", text: "Edit & ratify" },
        submit: { type: "plain_text", text: "Ratify" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "rule",
            label: { type: "plain_text", text: "Rule text" },
            element: {
              type: "plain_text_input",
              action_id: "rule_text",
              multiline: true,
              initial_value: ruleText,
            },
          },
        ],
      },
    }),
  }).catch(() => {});
}

export async function slackRoutes(app: FastifyInstance): Promise<void> {
  // Raw-body string parser, scoped to this plugin (Fastify encapsulates content type parsers).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/slack/actions", async (req, reply) => {
    const secret = env.LOCKSTEP_SLACK_SIGNING_SECRET;
    if (!secret) return reply.code(503).send({ error: "slack interactivity not configured" });
    const rawBody = typeof req.body === "string" ? req.body : "";
    const ok = verifySlackSignature({
      signingSecret: secret,
      timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
      signature: req.headers["x-slack-signature"] as string | undefined,
      rawBody,
    });
    if (!ok) return reply.code(401).send({ error: "bad signature" });

    const payloadRaw = new URLSearchParams(rawBody).get("payload");
    if (!payloadRaw) return reply.code(400).send({ error: "payload required" });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "payload must be JSON" });
    }

    const slackUserId = (payload.user as { id?: string } | undefined)?.id ?? "";

    if (payload.type === "block_actions") {
      const actions = (payload.actions as Array<{ action_id?: string; value?: string }> | undefined) ?? [];
      const act = actions[0];
      const responseUrl = payload.response_url as string | undefined;
      if (!act?.action_id || !act.value) return reply.code(200).send();
      let ref: SlackAction;
      try {
        ref = JSON.parse(act.value) as SlackAction;
      } catch {
        return reply.code(200).send();
      }
      const memberId = await memberForSlackUser(ref.orgId, slackUserId);
      if (!memberId) {
        respondVia(
          responseUrl,
          "This Slack account isn't linked to a Lockstep member yet — ask an admin to set your Slack id in Lockstep, then try again.",
        );
        return reply.code(200).send();
      }
      try {
        if (act.action_id === "ratify") {
          await ratifyDecision(ref.orgId, ref.decisionId, memberId);
          respondVia(responseUrl, "✅ Ratified — the constraint is now binding and will reach agent briefings.");
        } else if (act.action_id === "reject") {
          await rejectDecision(ref.orgId, ref.decisionId, memberId);
          respondVia(responseUrl, "Rejected — the candidate will not bind.");
        } else if (act.action_id === "edit") {
          const ruleText = await currentRuleText(ref.orgId, ref.decisionId);
          await openEditModal(payload.trigger_id as string, ref, ruleText);
        }
      } catch (err) {
        respondVia(responseUrl, `Could not complete that action: ${(err as Error).message}`);
      }
      return reply.code(200).send();
    }

    if (payload.type === "view_submission") {
      const view = payload.view as
        | { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string }>> } }
        | undefined;
      if (view?.callback_id !== "lockstep_ratify_edit") return reply.code(200).send();
      let ref: SlackAction;
      try {
        ref = JSON.parse(view.private_metadata ?? "") as SlackAction;
      } catch {
        return reply.code(200).send();
      }
      const memberId = await memberForSlackUser(ref.orgId, slackUserId);
      if (!memberId) {
        return reply.code(200).send({
          response_action: "errors",
          errors: { rule: "This Slack account isn't linked to a Lockstep member." },
        });
      }
      const ruleText = view.state?.values?.rule?.rule_text?.value ?? undefined;
      try {
        await ratifyDecision(ref.orgId, ref.decisionId, memberId, { ruleText });
        return reply.code(200).send({ response_action: "clear" });
      } catch (err) {
        return reply.code(200).send({
          response_action: "errors",
          errors: { rule: (err as Error).message },
        });
      }
    }

    return reply.code(200).send();
  });
}
