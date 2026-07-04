/**
 * Network half of the digest — posts the composed blocks as a DM via Slack's Web API using the
 * Lockstep bot token (chat.postMessage accepts a user id as `channel` and opens the DM). Split from
 * digest.ts so the pure composer stays under coverage; this file is coverage-excluded like the
 * other network files (client.ts, ComposioConnector.ts).
 */
export async function sendDigest(
  botToken: string,
  slackUserId: string,
  blocks: unknown[],
  fallbackText: string,
): Promise<{ ok: boolean; ts?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: slackUserId, text: fallbackText, blocks }),
  });
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { ok?: boolean; ts?: string };
  return { ok: Boolean(body.ok), ts: body.ts };
}
