/**
 * Concept classification queue: claim → classify (outside any tx) → conditional commit.
 *
 * Safety rules:
 *  - A commit only lands while the worker still OWNS an UNEXPIRED lease; otherwise it is discarded.
 *  - A result is written only if the target's revision is unchanged and no override pins the field.
 *  - Input that changes mid-classification marks the task dirty, so it re-runs on the latest input.
 *  - A failure never removes an existing placement; it only records last_error.
 *  - A rebuild is non-destructive and waits (durably, via concept_rebuild_items) for its work.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { withOrg, withSystem, type Tx } from "../db/rls.js";
import {
  conceptOverrides,
  conceptPlacements,
  conceptRebuilds,
  concepts,
  decisionVersions,
  decisions,
  domains,
  surfaces,
} from "../db/schema.js";
import { env } from "../env.js";
import { classifyChoice, type ChoiceInput, type ChoiceResult, type Keys } from "./classify.js";
import { conceptTaskKey, enqueueTx, placeDecisionCoreTx, placeSurfacesTx, projectStateTx } from "./concept-service.js";

export const MAX_ATTEMPTS = 5; // total attempts → 4 delays: 1m, 2m, 4m, 8m
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 2 * 60 * 60_000;
const JITTER = 0.2;
const LEASE_MS = 5 * 60_000;
export const CLAIM_BATCH = 20;
export const CLAIM_PER_PROJECT = 5;
export const PROVIDER_CONCURRENCY = 4;
const REBUILD_POLL_MS = 30_000;
const MAX_MODEL_CANDIDATES = 30;
const NONE = "__none__";

interface Claimed {
  id: string;
  orgId: string;
  projectId: string;
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown> | null;
  leaseToken: string;
  attempts: number;
}

const rows = <T>(r: unknown): T[] => r as T[];

/** Delay before retry `n` (1-based count of failures so far): 1m·2^(n-1), ±20% jitter, Retry-After wins. */
export function retryDelayMs(failures: number, retryAfterMs?: number, rand: () => number = Math.random): number {
  const base = BASE_DELAY_MS * 2 ** (failures - 1);
  const jittered = base * (1 - JITTER + 2 * JITTER * rand());
  return Math.round(Math.min(MAX_DELAY_MS, Math.max(jittered, retryAfterMs ?? 0)));
}

/* ───────────────────────────── claim ───────────────────────────── */

export async function claimConceptTasks(
  limit = CLAIM_BATCH,
  perProject = CLAIM_PER_PROJECT,
  projectId?: string,
): Promise<Claimed[]> {
  return withSystem(async (tx) => {
    const r = await tx.execute(sql`
      WITH due AS (
        SELECT id, project_id, next_attempt_at FROM concept_tasks
        WHERE ((state = 'queued' AND next_attempt_at <= now()) OR (state = 'running' AND locked_until < now()))
          ${projectId ? sql`AND project_id = ${projectId}` : sql``}
        ORDER BY next_attempt_at
        LIMIT ${limit * 10}
        FOR UPDATE SKIP LOCKED
      ), pick AS (
        SELECT id FROM (
          SELECT id, next_attempt_at, row_number() OVER (PARTITION BY project_id ORDER BY next_attempt_at) AS rn FROM due
        ) z WHERE rn <= ${perProject} ORDER BY next_attempt_at LIMIT ${limit}
      )
      UPDATE concept_tasks t SET state = 'running', lease_token = gen_random_uuid(),
        locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval, updated_at = now()
      FROM pick WHERE t.id = pick.id
      RETURNING t.id, t.org_id, t.project_id, t.kind, t.dedupe_key, t.payload, t.lease_token, t.attempts
    `);
    return rows<{
      id: string;
      org_id: string;
      project_id: string;
      kind: string;
      dedupe_key: string;
      payload: Record<string, unknown> | null;
      lease_token: string;
      attempts: number;
    }>(r).map((x) => ({
      id: x.id,
      orgId: x.org_id,
      projectId: x.project_id,
      kind: x.kind,
      dedupeKey: x.dedupe_key,
      payload: x.payload,
      leaseToken: x.lease_token,
      attempts: x.attempts,
    }));
  });
}

/* ───────────────────────────── lease-checked task transitions ───────────────────────────── */

class LeaseLost extends Error {}

/** The lease check every commit starts with: ownership AND expiry. Throws LeaseLost (→ rollback). */
async function holdLeaseTx(tx: Tx, t: Claimed): Promise<void> {
  const r = await tx.execute(sql`
    SELECT id FROM concept_tasks
    WHERE id = ${t.id} AND lease_token = ${t.leaseToken} AND state = 'running' AND locked_until > now()
    FOR UPDATE`);
  if (rows(r).length === 0) throw new LeaseLost();
}

/** Done — unless new input arrived while running (dirty), then back to the queue on the latest input. */
async function finishTx(tx: Tx, t: Claimed): Promise<void> {
  await tx.execute(sql`
    UPDATE concept_tasks SET
      state = CASE WHEN dirty THEN 'queued' ELSE 'done' END,
      payload = CASE WHEN dirty AND kind = 'rebuild' THEN '{}'::jsonb ELSE payload END,
      attempts = CASE WHEN dirty THEN 0 ELSE attempts END,
      dirty = false, lease_token = NULL, locked_until = NULL, last_error = NULL,
      next_attempt_at = now(), updated_at = now()
    WHERE id = ${t.id}`);
}

/** Back to the queue after `delayMs`. A retry re-reads the latest input, so dirty is cleared — except
 * when a rebuild is only polling, where dirty means "another rebuild was requested" and must stick. */
async function requeueTx(
  tx: Tx,
  t: Claimed,
  delayMs: number,
  patch: { attempts?: number; error?: string; keepDirty?: boolean } = {},
): Promise<void> {
  await tx.execute(sql`
    UPDATE concept_tasks SET state = 'queued', dirty = ${patch.keepDirty ? sql`dirty` : sql`false`},
      lease_token = NULL, locked_until = NULL,
      attempts = ${patch.attempts ?? t.attempts}, last_error = ${patch.error ?? null},
      next_attempt_at = now() + ${`${Math.round(delayMs)} milliseconds`}::interval, updated_at = now()
    WHERE id = ${t.id}`);
}

async function failTx(tx: Tx, t: Claimed, error: string, attempts: number): Promise<void> {
  await tx.execute(sql`
    UPDATE concept_tasks SET state = 'failed', dirty = false, lease_token = NULL, locked_until = NULL,
      attempts = ${attempts}, last_error = ${error}, updated_at = now()
    WHERE id = ${t.id}`);
}

/** Rebuild items this processed input covers are satisfied (success, pinned-discard or terminal failure). */
async function satisfyTx(tx: Tx, t: Claimed, claimedInputVersion: number): Promise<void> {
  await tx.execute(sql`
    UPDATE concept_rebuild_items SET satisfied_at = now()
    WHERE project_id = ${t.projectId} AND dedupe_key = ${t.dedupeKey} AND satisfied_at IS NULL
      AND required_input_version <= ${claimedInputVersion}`);
}

/* ───────────────────────────── snapshots (what the model sees) ───────────────────────────── */

type Snapshot =
  | { skip: true; inputVersion: number; reason: string }
  | { skip: false; inputVersion: number; revision: number; choice: ChoiceInput };

async function recordClaimTx(tx: Tx, t: Claimed, inputVersion: number): Promise<void> {
  await tx.execute(sql`UPDATE concept_tasks SET claimed_input_version = ${inputVersion} WHERE id = ${t.id}`);
}

async function conceptSnapshotTx(tx: Tx, t: Claimed): Promise<Snapshot> {
  const conceptId = String(t.payload?.conceptId ?? "");
  const c = (await tx.select().from(concepts).where(eq(concepts.id, conceptId)).limit(1))[0];
  if (!c || c.retiredAt) return { skip: true, inputVersion: c?.inputVersion ?? 0, reason: "gone" };
  const pinned = await tx
    .select({ id: conceptOverrides.id })
    .from(conceptOverrides)
    .where(
      and(
        eq(conceptOverrides.targetKind, "concept"),
        eq(conceptOverrides.targetId, c.id),
        eq(conceptOverrides.field, "domain"),
      ),
    )
    .limit(1);
  if (pinned.length > 0) return { skip: true, inputVersion: c.inputVersion, reason: "pinned" };
  const ds = await tx.select().from(domains).where(eq(domains.projectId, t.projectId)).orderBy(domains.position);
  if (ds.length === 0) return { skip: true, inputVersion: c.inputVersion, reason: "no_domains" };
  const members = await tx
    .select({ surface: surfaces.surface })
    .from(conceptPlacements)
    .innerJoin(surfaces, eq(surfaces.id, conceptPlacements.itemId))
    .where(and(eq(conceptPlacements.conceptId, c.id), eq(conceptPlacements.itemKind, "surface")))
    .limit(12);
  return {
    skip: false,
    inputVersion: c.inputVersion,
    revision: c.domainRevision,
    choice: {
      subject: { concept: c.label, key: c.key, exampleSurfaces: members.map((m) => m.surface) },
      instructions: "Which product domain does this concept (a group of API surfaces) belong to?",
      options: Object.fromEntries(ds.map((d) => [d.id, d.label])),
    },
  };
}

/** Candidate concepts for a decision the rules could not place: the scope's own, else a lexical shortlist. */
async function candidateConceptsTx(
  tx: Tx,
  projectId: string,
  ruleText: string,
  scoped: string[],
): Promise<Array<{ id: string; label: string; key: string }>> {
  const live = await tx
    .select({ id: concepts.id, label: concepts.label, key: concepts.key })
    .from(concepts)
    .where(and(eq(concepts.projectId, projectId), isNull(concepts.retiredAt)));
  if (scoped.length > 0) {
    const want = new Set(scoped);
    const hit = live.filter((c) => want.has(c.id));
    if (hit.length > 0) return hit.slice(0, MAX_MODEL_CANDIDATES);
  }
  // ponytail: lexical token overlap shortlist; swap for embeddings if large projects misplace often
  const words = new Set(
    ruleText
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
  const score = (c: { label: string; key: string }) =>
    `${c.label} ${c.key}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && (words.has(w) || words.has(w.replace(/s$/, "")) || words.has(`${w}s`))).length;
  return live
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.c.key.localeCompare(b.c.key))
    .slice(0, MAX_MODEL_CANDIDATES)
    .map((x) => x.c);
}

async function itemSnapshotTx(tx: Tx, t: Claimed): Promise<Snapshot> {
  const itemId = String(t.payload?.itemId ?? "");
  const p = (
    await tx
      .select()
      .from(conceptPlacements)
      .where(
        and(
          eq(conceptPlacements.projectId, t.projectId),
          eq(conceptPlacements.itemKind, "decision"),
          eq(conceptPlacements.itemId, itemId),
        ),
      )
      .limit(1)
  )[0];
  const d = (await tx.select().from(decisions).where(eq(decisions.id, itemId)).limit(1))[0];
  if (!p || !d) return { skip: true, inputVersion: p?.inputVersion ?? 0, reason: "gone" };
  const pinned = await tx
    .select({ id: conceptOverrides.id })
    .from(conceptOverrides)
    .where(
      and(
        eq(conceptOverrides.targetKind, "placement"),
        eq(conceptOverrides.targetId, itemId),
        eq(conceptOverrides.field, "location"),
      ),
    )
    .limit(1);
  if (pinned.length > 0) return { skip: true, inputVersion: p.inputVersion, reason: "pinned" };
  const v = (
    await tx
      .select({ ruleText: decisionVersions.ruleText })
      .from(decisionVersions)
      .where(eq(decisionVersions.decisionId, d.id))
      .orderBy(sql`${decisionVersions.version} DESC`)
      .limit(1)
  )[0];
  const ruleText = v?.ruleText ?? "";
  const scoped = Array.isArray(t.payload?.candidates) ? (t.payload!.candidates as string[]) : [];
  const cands = await candidateConceptsTx(tx, t.projectId, `${ruleText} ${d.scopeRef}`, scoped);
  if (cands.length === 0) return { skip: true, inputVersion: p.inputVersion, reason: "no_concepts" };
  return {
    skip: false,
    inputVersion: p.inputVersion,
    revision: p.revision,
    choice: {
      subject: { rule: ruleText.slice(0, 2000), scopeKind: d.scopeKind, scopeRef: d.scopeRef },
      instructions: "Which concept (area of the product) is this engineering/product rule primarily about?",
      options: {
        ...Object.fromEntries(cands.map((c) => [c.id, `${c.label} (${c.key})`])),
        [NONE]: "None of these concepts fits",
      },
    },
  };
}

/* ───────────────────────────── commits ───────────────────────────── */

async function commitConceptTx(
  tx: Tx,
  t: Claimed,
  snap: Extract<Snapshot, { skip: false }>,
  r: Extract<ChoiceResult, { ok: true }>,
): Promise<void> {
  await tx.execute(sql`
    UPDATE concepts SET domain_id = ${r.choice}, domain_state = 'suggested', domain_classifier = ${r.classifier},
      domain_confidence = ${r.confidence}, domain_revision = domain_revision + 1
    WHERE id = ${String(t.payload?.conceptId)} AND domain_revision = ${snap.revision}
      AND EXISTS (SELECT 1 FROM domains WHERE id = ${r.choice} AND project_id = ${t.projectId})
      AND NOT EXISTS (SELECT 1 FROM concept_overrides WHERE target_kind = 'concept'
        AND target_id = ${String(t.payload?.conceptId)} AND field = 'domain')`);
}

async function commitItemTx(
  tx: Tx,
  t: Claimed,
  snap: Extract<Snapshot, { skip: false }>,
  r: Extract<ChoiceResult, { ok: true }>,
): Promise<void> {
  const itemId = String(t.payload?.itemId);
  const guard = sql`project_id = ${t.projectId} AND item_kind = 'decision' AND item_id = ${itemId}
    AND revision = ${snap.revision}
    AND NOT EXISTS (SELECT 1 FROM concept_overrides WHERE target_kind = 'placement' AND target_id = ${itemId} AND field = 'location')`;
  if (r.choice === NONE) {
    // "nothing fits" never removes an existing placement; an unplaced item stays in Needs placement
    await tx.execute(sql`
      UPDATE concept_placements SET last_error = 'no_fit',
        state = CASE WHEN location = 'unplaced' THEN 'failed' ELSE state END,
        revision = revision + 1, updated_at = now()
      WHERE ${guard}`);
    return;
  }
  await tx.execute(sql`
    UPDATE concept_placements SET location = 'concept', concept_id = ${r.choice}, state = 'suggested',
      classifier = ${r.classifier}, confidence = ${r.confidence}, last_error = NULL,
      revision = revision + 1, updated_at = now()
    WHERE ${guard}
      AND EXISTS (SELECT 1 FROM concepts WHERE id = ${r.choice} AND project_id = ${t.projectId} AND retired_at IS NULL)`);
}

/** Record a failure on the target without touching an existing placement. */
async function markTargetFailedTx(tx: Tx, t: Claimed, error: string): Promise<void> {
  if (t.kind === "place_concept") {
    await tx.execute(sql`
      UPDATE concepts SET domain_state = CASE WHEN domain_id IS NULL THEN 'failed' ELSE domain_state END
      WHERE id = ${String(t.payload?.conceptId)}`);
  } else if (t.kind === "place_item") {
    await tx.execute(sql`
      UPDATE concept_placements SET last_error = ${error},
        state = CASE WHEN location = 'unplaced' THEN 'failed' ELSE state END, updated_at = now()
      WHERE project_id = ${t.projectId} AND item_kind = 'decision' AND item_id = ${String(t.payload?.itemId)}`);
  }
}

/* ───────────────────────────── processing ───────────────────────────── */

export type Outcome = "done" | "requeued" | "failed" | "lease_lost" | "skipped";

export type Classifier = (input: ChoiceInput) => Promise<ChoiceResult>;

async function processClassification(t: Claimed, classify: Classifier): Promise<Outcome> {
  // 1) snapshot in a short tx (records which input version this attempt covers)
  let snap: Snapshot;
  try {
    snap = await withOrg(t.orgId, async (tx) => {
      await holdLeaseTx(tx, t);
      const s = t.kind === "place_concept" ? await conceptSnapshotTx(tx, t) : await itemSnapshotTx(tx, t);
      await recordClaimTx(tx, t, s.inputVersion);
      if (s.skip) {
        if (s.reason === "no_concepts" || s.reason === "no_domains") await markTargetFailedTx(tx, t, s.reason);
        await satisfyTx(tx, t, s.inputVersion);
        await finishTx(tx, t);
      }
      return s;
    });
  } catch (e) {
    if (e instanceof LeaseLost) return "lease_lost";
    throw e;
  }
  if (snap.skip) return "skipped";

  // 2) the model call — outside any transaction
  const result = await classify(snap.choice);
  const s = snap;

  // 3) conditional commit
  try {
    return await withOrg(t.orgId, async (tx) => {
      await holdLeaseTx(tx, t);
      if (result.ok) {
        if (t.kind === "place_concept") await commitConceptTx(tx, t, s, result);
        else await commitItemTx(tx, t, s, result);
        await satisfyTx(tx, t, s.inputVersion);
        await finishTx(tx, t);
        return "done" as const;
      }
      if (result.reason === "no_provider") {
        await markTargetFailedTx(tx, t, "no_provider");
        await satisfyTx(tx, t, s.inputVersion);
        await failTx(tx, t, "no_provider", t.attempts);
        return "failed" as const;
      }
      const failures = t.attempts + 1;
      if (failures >= MAX_ATTEMPTS) {
        await markTargetFailedTx(tx, t, result.error);
        await satisfyTx(tx, t, s.inputVersion);
        await failTx(tx, t, result.error, failures);
        return "failed" as const;
      }
      await requeueTx(tx, t, retryDelayMs(failures, result.retryAfterMs), { attempts: failures, error: result.error });
      return "requeued" as const;
    });
  } catch (e) {
    if (e instanceof LeaseLost) return "lease_lost";
    throw e;
  }
}

/* ───────────────────────────── rebuild ───────────────────────────── */

async function processRebuild(t: Claimed): Promise<Outcome> {
  try {
    let rebuildId = typeof t.payload?.rebuildId === "string" ? t.payload.rebuildId : undefined;

    // start: bump the generation under FOR UPDATE (syncs hold FOR SHARE, so they serialize)
    if (!rebuildId) {
      rebuildId = await withOrg(t.orgId, async (tx) => {
        await holdLeaseTx(tx, t);
        await projectStateTx(tx, t.orgId, t.projectId);
        const [p] = rows<{ generation: number }>(
          await tx.execute(sql`
            UPDATE concept_projects SET generation = generation + 1 WHERE project_id = ${t.projectId}
            RETURNING generation`),
        );
        const [rb] = await tx
          .insert(conceptRebuilds)
          .values({ orgId: t.orgId, projectId: t.projectId, generation: p!.generation })
          .returning({ id: conceptRebuilds.id });
        await tx.execute(
          sql`UPDATE concept_tasks SET payload = ${JSON.stringify({ rebuildId: rb!.id })}::jsonb WHERE id = ${t.id}`,
        );
        return rb!.id;
      });
    }

    return await withOrg(t.orgId, async (tx) => {
      await holdLeaseTx(tx, t);
      const rb = (await tx.select().from(conceptRebuilds).where(eq(conceptRebuilds.id, rebuildId!)).limit(1))[0];
      if (!rb) {
        await finishTx(tx, t);
        return "done" as const;
      }

      if (rb.phase === "deriving") {
        const state = await projectStateTx(tx, t.orgId, t.projectId);
        const st = { generation: rb.generation, rules: state.rules };
        // surfaces: deterministic, confirmed now
        const surfaceRows = await tx.select().from(surfaces).where(eq(surfaces.projectId, t.projectId));
        await placeSurfacesTx(tx, t.orgId, t.projectId, surfaceRows, st, rb.id);
        // decisions: deterministic now; model-dependent keep their placement and are queued
        for (const d of await tx
          .select({ id: decisions.id })
          .from(decisions)
          .where(eq(decisions.projectId, t.projectId))) {
          await placeDecisionCoreTx(tx, t.orgId, d.id, { rebuildId: rb.id, state: st });
        }
        // every concept's domain is re-filed unless a human pinned it
        const pinned = new Set(
          (
            await tx
              .select({ id: conceptOverrides.targetId })
              .from(conceptOverrides)
              .where(
                and(
                  eq(conceptOverrides.projectId, t.projectId),
                  eq(conceptOverrides.targetKind, "concept"),
                  eq(conceptOverrides.field, "domain"),
                ),
              )
          ).map((x) => x.id),
        );
        for (const c of await tx
          .select({ id: concepts.id, inputVersion: concepts.inputVersion })
          .from(concepts)
          .where(and(eq(concepts.projectId, t.projectId), isNull(concepts.retiredAt)))) {
          if (pinned.has(c.id)) continue;
          await tx.execute(sql`
            INSERT INTO concept_rebuild_items (org_id, project_id, rebuild_id, dedupe_key, required_input_version)
            VALUES (${t.orgId}, ${t.projectId}, ${rb.id}, ${conceptTaskKey(c.id)}, ${c.inputVersion})
            ON CONFLICT (rebuild_id, dedupe_key) DO NOTHING`);
          await enqueueTx(tx, {
            orgId: t.orgId,
            projectId: t.projectId,
            kind: "place_concept",
            dedupeKey: conceptTaskKey(c.id),
            payload: { conceptId: c.id },
            requiredInputVersion: c.inputVersion,
          });
        }
        await tx.update(conceptRebuilds).set({ phase: "classifying" }).where(eq(conceptRebuilds.id, rb.id));
        rb.phase = "classifying";
      }

      if (rb.phase === "classifying") {
        const [open] = rows<{ n: number }>(
          await tx.execute(sql`
            SELECT count(*)::int AS n FROM concept_rebuild_items WHERE rebuild_id = ${rb.id} AND satisfied_at IS NULL`),
        );
        if (open!.n > 0) {
          // the singleton stays live (queued) until reconciliation completes
          await requeueTx(tx, t, REBUILD_POLL_MS, { keepDirty: true });
          return "requeued" as const;
        }
        await tx.update(conceptRebuilds).set({ phase: "reconciling" }).where(eq(conceptRebuilds.id, rb.id));
      }

      // reconciling: only now are obsolete derived refs dropped and orphan concepts retired
      await tx.execute(sql`
        DELETE FROM concept_refs WHERE project_id = ${t.projectId}
          AND source IN ('scope', 'capability') AND generation < ${rb.generation}`);
      await tx.execute(sql`
        UPDATE concepts c SET retired_at = now()
        WHERE c.project_id = ${t.projectId} AND c.retired_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM concept_placements p WHERE p.concept_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM concept_refs r WHERE r.concept_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM concept_aliases a WHERE a.concept_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM concept_overrides o WHERE o.target_kind = 'concept' AND o.target_id = c.id)`);
      await tx
        .update(conceptRebuilds)
        .set({ phase: "done", finishedAt: sql`now()` })
        .where(eq(conceptRebuilds.id, rb.id));
      await finishTx(tx, t);
      return "done" as const;
    });
  } catch (e) {
    if (e instanceof LeaseLost) return "lease_lost";
    throw e;
  }
}

/* ───────────────────────────── drain ───────────────────────────── */

const defaultKeys = (): Keys => ({ jev: env.TYPESAFE_API_KEY, claude: env.ANTHROPIC_API_KEY });

/** no_provider work is retried as soon as a provider is configured — no rebuild needed. */
export async function requeueNoProvider(): Promise<number> {
  return withSystem(async (tx) => {
    const r = await tx.execute(sql`
      UPDATE concept_tasks t SET state = 'queued', attempts = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
      WHERE t.state = 'failed' AND t.last_error = 'no_provider'
        AND NOT EXISTS (SELECT 1 FROM concept_tasks o WHERE o.project_id = t.project_id
          AND o.dedupe_key = t.dedupe_key AND o.state IN ('queued', 'running'))
      RETURNING t.id`);
    return rows(r).length;
  });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export async function drainConceptTasks(
  opts: { keys?: Keys; classify?: Classifier; projectId?: string; batch?: number; perProject?: number } = {},
): Promise<Record<Outcome, number> & { claimed: number }> {
  const keys = opts.keys ?? defaultKeys();
  const classify: Classifier = opts.classify ?? ((input) => classifyChoice(input, keys));
  if (keys.jev || keys.claude) await requeueNoProvider();
  await withSystem((tx) =>
    tx.execute(sql`DELETE FROM concept_tasks WHERE state = 'done' AND updated_at < now() - interval '1 day'`),
  );
  const claimed = await claimConceptTasks(
    opts.batch ?? CLAIM_BATCH,
    opts.perProject ?? CLAIM_PER_PROJECT,
    opts.projectId,
  );
  const outcomes = await pool(claimed, PROVIDER_CONCURRENCY, async (t): Promise<Outcome> => {
    try {
      return t.kind === "rebuild" ? await processRebuild(t) : await processClassification(t, classify);
    } catch (e) {
      console.error(`[concepts] task ${t.kind} ${t.id} errored:`, e);
      return "requeued"; // lease expiry makes it claimable again
    }
  });
  const tally = { claimed: claimed.length, done: 0, requeued: 0, failed: 0, lease_lost: 0, skipped: 0 };
  for (const o of outcomes) tally[o]++;
  return tally;
}
