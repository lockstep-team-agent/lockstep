import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request signing (v0): signature = "v0=" + HMAC_SHA256(secret, "v0:{timestamp}:{rawBody}").
 * Hand-rolled on node:crypto — the algorithm is 15 lines and the repo stays minimal-dep. Rejects
 * stale timestamps (>5 min skew) to blunt replay.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now / 1000 - ts) > 60 * 5) return false;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${input.timestamp}:${input.rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
