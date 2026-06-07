import { randomBytes, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accessTokens, principals } from "../db/schema.js";
import { withSystem, type Tx } from "../db/rls.js";

export interface Principal {
  id: string;
  githubUserId: number;
  githubLogin: string;
}

export function generateToken(): string {
  return "lsk_" + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Insert a session token within an existing system transaction; returns the plaintext token. */
export async function issueTokenTx(tx: Tx, principalId: string, scopes: string[] = []): Promise<string> {
  const token = generateToken();
  await tx.insert(accessTokens).values({ principalId, tokenHash: hashToken(token), scopes });
  return token;
}

export async function issueToken(principalId: string, scopes: string[] = []): Promise<string> {
  return withSystem((tx) => issueTokenTx(tx, principalId, scopes));
}

/** Validate a bearer token → the authenticated principal (or null). System-scoped lookup. */
export async function validateToken(token: string): Promise<Principal | null> {
  const tokenHash = hashToken(token);
  return withSystem(async (tx) => {
    const at = (
      await tx
        .select()
        .from(accessTokens)
        .where(and(eq(accessTokens.tokenHash, tokenHash), eq(accessTokens.revoked, false)))
        .limit(1)
    )[0];
    if (!at) return null;
    if (at.expiresAt && at.expiresAt.getTime() < Date.now()) return null;
    const pr = (await tx.select().from(principals).where(eq(principals.id, at.principalId)).limit(1))[0];
    if (!pr) return null;
    return { id: pr.id, githubUserId: pr.githubUserId, githubLogin: pr.githubLogin };
  });
}
