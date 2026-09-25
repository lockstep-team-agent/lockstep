/**
 * Persistent scheduler (gateway). scheduled_jobs is a SYSTEM table — every job kind is cross-org
 * (expiry, weekly digests, writeback drain all run withSystem and iterate orgs themselves), so the
 * rows carry no org and are readable only under the system context.
 *
 * Claim protocol: FOR UPDATE SKIP LOCKED + a lease (locked_until) — two workers never double-run a
 * job; a crashed worker's lease expires and the job is claimable again. Completion reschedules
 * run_at by interval_seconds; a one-shot (null interval) is deleted on success and stays claimable
 * after a failure (its retry story). Executors live in the WORKER (it claims via
 * /internal/jobs/claim and calls the existing /internal/* endpoints per kind).
 */
import { eq, sql } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { scheduledJobs } from "../db/schema.js";

const LEASE_MS = 10 * 60 * 1000;

export async function claimDueJobs(now: Date = new Date()): Promise<Array<{ id: string; kind: string }>> {
  return withSystem(async (tx) => {
    const lease = new Date(now.getTime() + LEASE_MS).toISOString();
    const nowIso = now.toISOString();
    const rows = await tx.execute(sql`
      UPDATE scheduled_jobs
      SET locked_until = ${lease}::timestamptz, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM scheduled_jobs
        WHERE run_at <= ${nowIso}::timestamptz AND (locked_until IS NULL OR locked_until < ${nowIso}::timestamptz)
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind
    `);
    return (rows as unknown as Array<{ id: string; kind: string }>).map((r) => ({ id: r.id, kind: r.kind }));
  });
}

export async function completeJob(id: string, ok: boolean, error?: string): Promise<{ rescheduledFor: string | null }> {
  return withSystem(async (tx) => {
    const job = (await tx.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).limit(1))[0];
    if (!job) return { rescheduledFor: null };
    // A successful one-shot is done for good. Leaving the row (past run_at, lease cleared) made it
    // claimable again on every tick, since the claim never looks at last_status.
    if (ok && job.intervalSeconds == null) {
      await tx.delete(scheduledJobs).where(eq(scheduledJobs.id, id));
      return { rescheduledFor: null };
    }
    const now = new Date();
    const next = job.intervalSeconds != null ? new Date(now.getTime() + job.intervalSeconds * 1000) : null;
    await tx
      .update(scheduledJobs)
      .set({
        lockedUntil: null,
        lastStatus: ok ? "ok" : "error",
        lastError: ok ? null : (error ?? "unknown"),
        lastRunAt: now,
        // A failed one-shot keeps its past run_at, so it is retried on the next claim; recurring
        // jobs march forward from NOW, not from run_at, so a backlog never causes a run-storm.
        ...(next ? { runAt: next } : {}),
      })
      .where(eq(scheduledJobs.id, id));
    return { rescheduledFor: next ? next.toISOString() : null };
  });
}
