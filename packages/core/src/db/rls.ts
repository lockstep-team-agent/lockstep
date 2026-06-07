import { sql } from "drizzle-orm";
import { db } from "./client.js";

/** The transaction handle drizzle hands to a `.transaction()` callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a transaction scoped to a single org via Postgres RLS.
 *
 * Every read/write performed on `tx` is automatically filtered to `orgId`.
 * We SET LOCAL ROLE into the non-superuser `lockstep_app` role so RLS actually
 * applies (superusers/owners bypass it), and set `lockstep.org_id` for the policy.
 * Fail-closed: if a query ever runs without an org context, the policy compares
 * against NULL and returns zero rows.
 */
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE lockstep_app`);
    await tx.execute(sql`SELECT set_config('lockstep.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Trusted cross-org context for auth/login/onboarding only (token validation, member
 * & invite matching, repo→project resolution). NEVER call from a user-influenced path —
 * this bypasses org isolation by design. Keep its callers to a tiny, audited set.
 */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE lockstep_app`);
    await tx.execute(sql`SELECT set_config('lockstep.system', 'on', true)`);
    return fn(tx);
  });
}
