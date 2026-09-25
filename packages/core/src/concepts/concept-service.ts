/**
 * Concept ledger writes: stable surfaces, deterministic placement, the classification queue's
 * enqueue side, and field-scoped human overrides.
 *
 * Concepts are a NAVIGATION layer: nothing here changes what a decision governs. Every hook the
 * ledger calls runs in a savepoint and swallows its own errors — a concept bug must never fail a
 * decision proposal or a surface sync.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "../db/rls.js";
import { withOrg } from "../db/rls.js";
import {
  conceptAliases,
  conceptOverrides,
  conceptPlacements,
  conceptProjects,
  conceptRebuildItems,
  conceptRefs,
  concepts,
  decisions,
  domains,
  graphEdges,
  graphNodes,
  surfaces,
} from "../db/schema.js";
import { conceptKey, surfaceKind, RULE_VERSION, type HttpRules } from "./derive.js";

export const DEFAULT_DOMAINS: Array<{ key: string; label: string }> = [
  { key: "identity", label: "Identity & Access" },
  { key: "users", label: "Users & Accounts" },
  { key: "payments", label: "Payments & Billing" },
  { key: "content", label: "Content & Catalog" },
  { key: "messaging", label: "Messaging & Notifications" },
  { key: "data", label: "Data & Analytics" },
  { key: "integrations", label: "Integrations" },
  { key: "platform", label: "Platform & Infra" },
];
export const MAX_DOMAINS = 50;

export class ConceptError extends Error {
  constructor(
    public readonly code: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const rows = <T>(r: unknown): T[] => r as T[];

/* ───────────────────────────── project row + generation lock ───────────────────────────── */

/** Create the project's concept row; seed default domains only the first time (deleted stay deleted). */
export async function ensureConceptProjectTx(tx: Tx, orgId: string, projectId: string): Promise<void> {
  const created = await tx
    .insert(conceptProjects)
    .values({ projectId, orgId })
    .onConflictDoNothing()
    .returning({ projectId: conceptProjects.projectId });
  if (created.length === 0) return;
  await tx
    .insert(domains)
    .values(DEFAULT_DOMAINS.map((d, i) => ({ orgId, projectId, key: d.key, label: d.label, position: i })))
    .onConflictDoNothing();
}

/**
 * Current generation + rules, holding FOR SHARE on the project row: a sync serializes against a
 * rebuild's generation bump (FOR UPDATE), so anything written during a rebuild carries its generation.
 */
export async function projectStateTx(
  tx: Tx,
  orgId: string,
  projectId: string,
): Promise<{ generation: number; rules: HttpRules | undefined }> {
  await ensureConceptProjectTx(tx, orgId, projectId);
  const r = rows<{ generation: number; http_rules: HttpRules | null }>(
    await tx.execute(
      sql`SELECT generation, http_rules FROM concept_projects WHERE project_id = ${projectId} FOR SHARE`,
    ),
  )[0]!;
  return { generation: r.generation, rules: r.http_rules ?? undefined };
}

/* ───────────────────────────── queue: enqueue side ───────────────────────────── */

export interface EnqueueInput {
  orgId: string;
  projectId: string;
  kind: "place_item" | "place_concept" | "rebuild";
  dedupeKey: string;
  payload?: Record<string, unknown>;
  /** The target's input version this work must cover. A running attempt that claimed an older
   * version is marked dirty (it re-runs on the latest input); one that already covers it is left. */
  requiredInputVersion: number;
}

/** Transactional enqueue: call inside the SAME tx as the write that makes the work necessary. */
export async function enqueueTx(tx: Tx, t: EnqueueInput): Promise<void> {
  await tx.execute(sql`
    INSERT INTO concept_tasks (org_id, project_id, kind, dedupe_key, payload)
    VALUES (${t.orgId}, ${t.projectId}, ${t.kind}, ${t.dedupeKey}, ${JSON.stringify(t.payload ?? {})}::jsonb)
    ON CONFLICT (project_id, dedupe_key) WHERE state IN ('queued', 'running')
    DO UPDATE SET
      dirty = concept_tasks.dirty OR (concept_tasks.state = 'running'
        AND COALESCE(concept_tasks.claimed_input_version, -1) < ${t.requiredInputVersion}),
      next_attempt_at = LEAST(concept_tasks.next_attempt_at, now()),
      updated_at = now()
  `);
}

/** Enqueue AND register the work with a rebuild (counted once per rebuild + target). */
async function enqueueForRebuildTx(tx: Tx, t: EnqueueInput, rebuildId: string | undefined): Promise<void> {
  if (rebuildId) {
    await tx
      .insert(conceptRebuildItems)
      .values({
        orgId: t.orgId,
        projectId: t.projectId,
        rebuildId,
        dedupeKey: t.dedupeKey,
        requiredInputVersion: t.requiredInputVersion,
      })
      .onConflictDoNothing();
  }
  await enqueueTx(tx, t);
}

export const conceptTaskKey = (conceptId: string): string => `place_concept:${conceptId}`;
export const itemTaskKey = (itemKind: string, itemId: string): string => `place_item:${itemKind}:${itemId}`;

export async function enqueueRebuildTx(tx: Tx, orgId: string, projectId: string): Promise<void> {
  // A rebuild's "input" is the whole project; any request while one runs asks for another pass.
  await enqueueTx(tx, {
    orgId,
    projectId,
    kind: "rebuild",
    dedupeKey: `rebuild:${projectId}`,
    requiredInputVersion: 2_147_483_647, // int4 max: always newer than any claimed version
  });
}

/* ───────────────────────────── overrides ───────────────────────────── */

async function pinnedTx(tx: Tx, targetKind: string, targetIds: string[], field: string): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const r = await tx
    .select({ id: conceptOverrides.targetId })
    .from(conceptOverrides)
    .where(
      and(
        eq(conceptOverrides.targetKind, targetKind),
        eq(conceptOverrides.field, field),
        inArray(conceptOverrides.targetId, targetIds),
      ),
    );
  return new Set(r.map((x) => x.id));
}

/* ───────────────────────────── concepts from keys ───────────────────────────── */

/**
 * Resolve concept keys to live concept ids: alias first (a merged key resolves to its survivor, so
 * a sync never recreates it), then an existing concept, else create one and queue its domain.
 */
export async function resolveConceptsTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  wanted: Map<string, string>, // key → label
  gen: number,
  rebuildId?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const keys = [...wanted.keys()];
  if (keys.length === 0) return out;
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    for (const a of await tx
      .select()
      .from(conceptAliases)
      .where(and(eq(conceptAliases.projectId, projectId), inArray(conceptAliases.aliasKey, chunk)))) {
      out.set(a.aliasKey, a.conceptId);
    }
    const direct = chunk.filter((k) => !out.has(k));
    if (direct.length === 0) continue;
    for (const c of await tx
      .select({ id: concepts.id, key: concepts.key })
      .from(concepts)
      .where(and(eq(concepts.projectId, projectId), inArray(concepts.key, direct)))) {
      out.set(c.key, c.id);
    }
    const missing = direct.filter((k) => !out.has(k));
    if (missing.length > 0) {
      const created = await tx
        .insert(concepts)
        .values(
          missing.map((k) => ({
            orgId,
            projectId,
            key: k,
            label: wanted.get(k)!,
            ruleVersion: RULE_VERSION,
            generation: gen,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: concepts.id, key: concepts.key, inputVersion: concepts.inputVersion });
      for (const c of created) {
        out.set(c.key, c.id);
        await enqueueForRebuildTx(
          tx,
          {
            orgId,
            projectId,
            kind: "place_concept",
            dedupeKey: conceptTaskKey(c.id),
            payload: { conceptId: c.id },
            requiredInputVersion: c.inputVersion,
          },
          rebuildId,
        );
      }
      // a concurrent writer may have created one between our read and insert
      const raced = missing.filter((k) => !out.has(k));
      if (raced.length > 0) {
        for (const c of await tx
          .select({ id: concepts.id, key: concepts.key })
          .from(concepts)
          .where(and(eq(concepts.projectId, projectId), inArray(concepts.key, raced)))) {
          out.set(c.key, c.id);
        }
      }
    }
  }
  const ids = [...new Set(out.values())];
  if (ids.length > 0) {
    await tx
      .update(concepts)
      .set({ generation: gen, retiredAt: null })
      .where(
        and(inArray(concepts.id, ids), sql`(${concepts.generation} < ${gen} OR ${concepts.retiredAt} IS NOT NULL)`),
      );
  }
  return out;
}

/* ───────────────────────────── surfaces ───────────────────────────── */

export interface SurfaceEntry {
  surface: string;
  returnType?: string | null;
  returnTypeKind?: string | null;
}

/** Accept `"http:GET /x"` and `{surface, returnType?, returnTypeKind?}` alike (older CLIs send strings). */
export function normalizeSurfaceEntries(input: unknown[]): SurfaceEntry[] {
  const out = new Map<string, SurfaceEntry>();
  for (const e of input) {
    if (typeof e === "string" && e) out.set(e, { surface: e });
    else if (e && typeof e === "object" && typeof (e as SurfaceEntry).surface === "string") {
      const x = e as SurfaceEntry;
      const rt = typeof x.returnType === "string" && x.returnType ? x.returnType : null;
      out.set(x.surface, {
        surface: x.surface,
        returnType: rt,
        returnTypeKind: rt && typeof x.returnTypeKind === "string" ? x.returnTypeKind : null,
      });
    }
  }
  return [...out.values()];
}

type SurfaceRow = typeof surfaces.$inferSelect;

/**
 * Upsert stable surface rows. GraphQL metadata updates AS A PAIR keyed on returnType presence:
 * omitted (older CLI) → both stored fields kept; present → both replaced, unresolved kind = unknown.
 */
export async function upsertSurfacesTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  repoId: string,
  entries: SurfaceEntry[],
): Promise<SurfaceRow[]> {
  const out: SurfaceRow[] = [];
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    out.push(
      ...(await tx
        .insert(surfaces)
        .values(
          chunk.map((e) => ({
            orgId,
            projectId,
            repoId,
            surface: e.surface,
            kind: surfaceKind(e.surface),
            returnType: e.returnType ?? null,
            returnTypeKind: e.returnType ? (e.returnTypeKind ?? "unknown") : null,
          })),
        )
        .onConflictDoUpdate({
          target: [surfaces.repoId, surfaces.surface],
          set: {
            lastSeen: sql`now()`,
            removedAt: sql`NULL`,
            returnType: sql`CASE WHEN excluded.return_type IS NULL THEN ${surfaces.returnType} ELSE excluded.return_type END`,
            returnTypeKind: sql`CASE WHEN excluded.return_type IS NULL THEN ${surfaces.returnTypeKind}
              ELSE COALESCE(excluded.return_type_kind, 'unknown') END`,
          },
        })
        .returning()),
    );
  }
  return out;
}

/** Deterministic, auto-confirmed placement of surfaces into their concept (pinned ones untouched). */
export async function placeSurfacesTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  rowsIn: SurfaceRow[],
  state: { generation: number; rules: HttpRules | undefined },
  rebuildId?: string,
): Promise<void> {
  if (rowsIn.length === 0) return;
  const keyOf = new Map<string, string>();
  const wanted = new Map<string, string>();
  for (const s of rowsIn) {
    const k = conceptKey(s.surface, s.returnType, s.returnTypeKind, state.rules);
    keyOf.set(s.id, k.key);
    if (!wanted.has(k.key)) wanted.set(k.key, k.label);
  }
  const conceptOf = await resolveConceptsTx(tx, orgId, projectId, wanted, state.generation, rebuildId);
  const pinned = await pinnedTx(
    tx,
    "placement",
    rowsIn.map((s) => s.id),
    "location",
  );
  const values = rowsIn
    .filter((s) => !pinned.has(s.id))
    .map((s) => ({
      orgId,
      projectId,
      itemKind: "surface",
      itemId: s.id,
      location: "concept",
      conceptId: conceptOf.get(keyOf.get(s.id)!)!,
      state: "confirmed",
      classifier: "rule",
      confidence: 1,
      generation: state.generation,
    }));
  for (let i = 0; i < values.length; i += 500) {
    await tx
      .insert(conceptPlacements)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [conceptPlacements.projectId, conceptPlacements.itemKind, conceptPlacements.itemId],
        set: {
          revision: sql`CASE WHEN ${conceptPlacements.conceptId} IS DISTINCT FROM excluded.concept_id
            OR ${conceptPlacements.state} <> 'confirmed' THEN ${conceptPlacements.revision} + 1
            ELSE ${conceptPlacements.revision} END`,
          location: sql`excluded.location`,
          conceptId: sql`excluded.concept_id`,
          state: sql`excluded.state`,
          classifier: sql`excluded.classifier`,
          confidence: sql`excluded.confidence`,
          generation: sql`excluded.generation`,
          lastError: sql`NULL`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/** Sync hook: stable surface rows + contract history link + deterministic placement. */
export async function syncSurfacesTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  repoId: string,
  entries: SurfaceEntry[],
): Promise<SurfaceRow[]> {
  if (entries.length === 0) return [];
  return guarded(
    tx,
    "syncSurfaces",
    async (sp) => {
      const state = await projectStateTx(sp, orgId, projectId);
      const rowsOut = await upsertSurfacesTx(sp, orgId, projectId, repoId, entries);
      await sp.execute(sql`
      UPDATE contracts c SET surface_id = s.id FROM surfaces s
      WHERE s.repo_id = ${repoId} AND c.repo_id = s.repo_id AND c.surface = s.surface AND c.surface_id IS NULL`);
      await placeSurfacesTx(sp, orgId, projectId, rowsOut, state);
      return rowsOut;
    },
    [],
  );
}

/** Run a concept hook in a savepoint; a failure is logged and rolled back, never propagated. */
async function guarded<T>(tx: Tx, what: string, fn: (sp: Tx) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await tx.transaction(fn);
  } catch (e) {
    console.error(`[concepts] ${what} failed (ledger write unaffected):`, e);
    return fallback;
  }
}

/* ───────────────────────────── decisions ───────────────────────────── */

type Destination =
  | { kind: "project_wide" }
  | { kind: "concept"; conceptId: string }
  | { kind: "model"; candidates: string[] }; // candidate concept ids ([] = any concept)

/** The concepts a surface ID maps to, using any produced surface row's GraphQL metadata. */
async function conceptKeysForSurfaceTx(
  tx: Tx,
  projectId: string,
  surface: string,
  rules: HttpRules | undefined,
): Promise<Map<string, string>> {
  const known = await tx
    .select()
    .from(surfaces)
    .where(and(eq(surfaces.projectId, projectId), eq(surfaces.surface, surface)));
  const out = new Map<string, string>();
  for (const s of known.length > 0 ? known : [{ surface, returnType: null, returnTypeKind: null }]) {
    const k = conceptKey(s.surface, s.returnType, s.returnTypeKind, rules);
    out.set(k.key, k.label);
  }
  return out;
}

async function capabilitySurfaceRefsTx(tx: Tx, projectId: string, capabilityRef: string): Promise<string[]> {
  const node = (
    await tx
      .select({ id: graphNodes.id })
      .from(graphNodes)
      .where(
        and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability"), eq(graphNodes.ref, capabilityRef)),
      )
      .limit(1)
  )[0];
  if (!node) return [];
  const r = await tx
    .select({ ref: graphNodes.ref })
    .from(graphEdges)
    .innerJoin(graphNodes, eq(graphNodes.id, graphEdges.toId))
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.fromId, node.id),
        eq(graphEdges.kind, "governs"),
        eq(graphEdges.status, "confirmed"),
        eq(graphNodes.kind, "surface"),
      ),
    );
  return r.map((x) => x.ref);
}

/**
 * Where a decision goes. Deterministic ONLY when scope yields exactly one destination: a project
 * rule → Project-wide; a surface or capability whose concepts collapse to one → that concept.
 * Everything else (repo/topic scope, capability spanning several concepts) is the model's call.
 */
async function decisionDestinationTx(
  tx: Tx,
  orgId: string,
  d: { projectId: string; scopeKind: string; scopeRef: string },
  state: { generation: number; rules: HttpRules | undefined },
  rebuildId?: string,
): Promise<{ dest: Destination; related: string[] }> {
  if (d.scopeKind === "project") return { dest: { kind: "project_wide" }, related: [] };
  let wanted = new Map<string, string>();
  if (d.scopeKind === "surface") wanted = await conceptKeysForSurfaceTx(tx, d.projectId, d.scopeRef, state.rules);
  else if (d.scopeKind === "capability") {
    for (const s of await capabilitySurfaceRefsTx(tx, d.projectId, d.scopeRef)) {
      for (const [k, l] of await conceptKeysForSurfaceTx(tx, d.projectId, s, state.rules)) wanted.set(k, l);
    }
  }
  if (wanted.size === 0) return { dest: { kind: "model", candidates: [] }, related: [] };
  const ids = [
    ...new Set((await resolveConceptsTx(tx, orgId, d.projectId, wanted, state.generation, rebuildId)).values()),
  ];
  if (ids.length === 1) return { dest: { kind: "concept", conceptId: ids[0]! }, related: ids };
  return { dest: { kind: "model", candidates: ids }, related: ids };
}

/**
 * Place (or re-place) a decision. `inputChanged` = its rule text changed (a new version), which
 * bumps input_version so any in-flight classification of the old text is superseded.
 */
export async function placeDecisionCoreTx(
  tx: Tx,
  orgId: string,
  decisionId: string,
  opts: { inputChanged?: boolean; rebuildId?: string; state?: { generation: number; rules: HttpRules | undefined } },
): Promise<void> {
  const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
  if (!d) return;
  const state = opts.state ?? (await projectStateTx(tx, orgId, d.projectId));
  const { dest, related } = await decisionDestinationTx(tx, orgId, d, state, opts.rebuildId);

  // scope/capability-derived cross references (the "also relevant in" links), stamped with gen
  if (related.length > 1) {
    await tx
      .insert(conceptRefs)
      .values(
        related.map((conceptId) => ({
          orgId,
          projectId: d.projectId,
          itemKind: "decision",
          itemId: d.id,
          conceptId,
          source: d.scopeKind === "capability" ? "capability" : "scope",
          generation: state.generation,
        })),
      )
      .onConflictDoUpdate({
        target: [conceptRefs.itemKind, conceptRefs.itemId, conceptRefs.conceptId],
        set: { generation: sql`GREATEST(${conceptRefs.generation}, excluded.generation)` },
      });
  }

  const pinned = (await pinnedTx(tx, "placement", [d.id], "location")).has(d.id);
  const existing = (
    await tx
      .select()
      .from(conceptPlacements)
      .where(
        and(
          eq(conceptPlacements.projectId, d.projectId),
          eq(conceptPlacements.itemKind, "decision"),
          eq(conceptPlacements.itemId, d.id),
        ),
      )
      .limit(1)
  )[0];
  if (pinned) return; // a human put it somewhere; nothing derived may move it

  if (dest.kind !== "model") {
    const location = dest.kind === "project_wide" ? "project_wide" : "concept";
    const conceptId = dest.kind === "concept" ? dest.conceptId : null;
    await tx
      .insert(conceptPlacements)
      .values({
        orgId,
        projectId: d.projectId,
        itemKind: "decision",
        itemId: d.id,
        location,
        conceptId,
        state: "confirmed",
        classifier: "rule",
        confidence: 1,
        generation: state.generation,
      })
      .onConflictDoUpdate({
        target: [conceptPlacements.projectId, conceptPlacements.itemKind, conceptPlacements.itemId],
        set: {
          location,
          conceptId,
          state: "confirmed",
          classifier: "rule",
          confidence: 1,
          lastError: null,
          generation: state.generation,
          revision: sql`${conceptPlacements.revision} + 1`,
          inputVersion: opts.inputChanged
            ? sql`${conceptPlacements.inputVersion} + 1`
            : sql`${conceptPlacements.inputVersion}`,
          updatedAt: sql`now()`,
        },
      });
    return;
  }

  // model-dependent: keep whatever placement exists, bump the input on change, queue the work
  let inputVersion: number;
  if (!existing) {
    const created = await tx
      .insert(conceptPlacements)
      .values({ orgId, projectId: d.projectId, itemKind: "decision", itemId: d.id, generation: state.generation })
      .onConflictDoNothing()
      .returning({ inputVersion: conceptPlacements.inputVersion });
    inputVersion = created[0]?.inputVersion ?? 1;
  } else if (opts.inputChanged) {
    const bumped = await tx
      .update(conceptPlacements)
      .set({ inputVersion: sql`${conceptPlacements.inputVersion} + 1`, updatedAt: sql`now()` })
      .where(eq(conceptPlacements.id, existing.id))
      .returning({ inputVersion: conceptPlacements.inputVersion });
    inputVersion = bumped[0]!.inputVersion;
  } else {
    inputVersion = existing.inputVersion;
  }
  await enqueueForRebuildTx(
    tx,
    {
      orgId,
      projectId: d.projectId,
      kind: "place_item",
      dedupeKey: itemTaskKey("decision", d.id),
      payload: { itemKind: "decision", itemId: d.id, candidates: dest.candidates },
      requiredInputVersion: inputVersion,
    },
    opts.rebuildId,
  );
}

/** Ledger hook: call after a decision is created or gets a new version. Never throws. */
export async function placeDecisionTx(
  tx: Tx,
  orgId: string,
  decisionId: string,
  opts: { inputChanged?: boolean } = {},
): Promise<void> {
  await guarded(tx, "placeDecision", (sp) => placeDecisionCoreTx(sp, orgId, decisionId, opts), undefined);
}

/* ───────────────────────────── human edits (field-scoped overrides) ───────────────────────────── */

async function writeOverrideTx(
  tx: Tx,
  o: {
    orgId: string;
    projectId: string;
    targetKind: string;
    targetId: string;
    field: string;
    payload: unknown;
    by: string;
  },
): Promise<void> {
  await tx
    .insert(conceptOverrides)
    .values({
      orgId: o.orgId,
      projectId: o.projectId,
      targetKind: o.targetKind,
      targetId: o.targetId,
      field: o.field,
      payload: o.payload,
      byMemberId: o.by,
    })
    .onConflictDoUpdate({
      target: [conceptOverrides.targetKind, conceptOverrides.targetId, conceptOverrides.field],
      set: { payload: o.payload, byMemberId: o.by, createdAt: sql`now()` },
    });
}

async function liveConceptTx(tx: Tx, projectId: string, conceptId: string): Promise<typeof concepts.$inferSelect> {
  const c = (
    await tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, conceptId), eq(concepts.projectId, projectId), isNull(concepts.retiredAt)))
      .limit(1)
  )[0];
  if (!c) throw new ConceptError(404, "concept not found");
  return c;
}

/** Rename pins the LABEL only; the domain stays automatic, so the new label is re-classified. */
export async function renameConcept(
  orgId: string,
  projectId: string,
  conceptId: string,
  label: string,
  by: string,
): Promise<void> {
  const clean = label.trim().slice(0, 120);
  if (!clean) throw new ConceptError(400, "label required");
  await withOrg(orgId, async (tx) => {
    await liveConceptTx(tx, projectId, conceptId);
    await writeOverrideTx(tx, {
      orgId,
      projectId,
      targetKind: "concept",
      targetId: conceptId,
      field: "label",
      payload: { label: clean },
      by,
    });
    const [c] = await tx
      .update(concepts)
      .set({ label: clean, inputVersion: sql`${concepts.inputVersion} + 1` })
      .where(eq(concepts.id, conceptId))
      .returning();
    if (!(await pinnedTx(tx, "concept", [conceptId], "domain")).has(conceptId)) {
      await enqueueTx(tx, {
        orgId,
        projectId,
        kind: "place_concept",
        dedupeKey: conceptTaskKey(conceptId),
        payload: { conceptId },
        requiredInputVersion: c!.inputVersion,
      });
    }
  });
}

/** Move (or confirm) a concept's domain. Pins the DOMAIN field only. */
export async function setConceptDomain(
  orgId: string,
  projectId: string,
  conceptId: string,
  domainId: string,
  by: string,
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await liveConceptTx(tx, projectId, conceptId);
    const d = (
      await tx
        .select()
        .from(domains)
        .where(and(eq(domains.id, domainId), eq(domains.projectId, projectId)))
        .limit(1)
    )[0];
    if (!d) throw new ConceptError(404, "domain not found");
    await writeOverrideTx(tx, {
      orgId,
      projectId,
      targetKind: "concept",
      targetId: conceptId,
      field: "domain",
      payload: { domainId },
      by,
    });
    await tx
      .update(concepts)
      .set({
        domainId,
        domainState: "confirmed",
        domainClassifier: "human",
        domainConfidence: 1,
        domainRevision: sql`${concepts.domainRevision} + 1`,
      })
      .where(eq(concepts.id, conceptId));
  });
}

/** Move (or confirm) an item's primary location. Pins the LOCATION field only. */
export async function placeItem(
  orgId: string,
  projectId: string,
  itemKind: "surface" | "decision",
  itemId: string,
  target: { conceptId: string } | { projectWide: true },
  by: string,
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const owned =
      itemKind === "surface"
        ? (
            await tx
              .select({ id: surfaces.id })
              .from(surfaces)
              .where(and(eq(surfaces.id, itemId), eq(surfaces.projectId, projectId)))
              .limit(1)
          )[0]
        : (
            await tx
              .select({ id: decisions.id })
              .from(decisions)
              .where(and(eq(decisions.id, itemId), eq(decisions.projectId, projectId)))
              .limit(1)
          )[0];
    if (!owned) throw new ConceptError(404, "item not found");
    const conceptId = "conceptId" in target ? target.conceptId : null;
    if (conceptId) await liveConceptTx(tx, projectId, conceptId);
    const location = conceptId ? "concept" : "project_wide";
    await writeOverrideTx(tx, {
      orgId,
      projectId,
      targetKind: "placement",
      targetId: itemId,
      field: "location",
      payload: { conceptId, location },
      by,
    });
    await tx
      .insert(conceptPlacements)
      .values({
        orgId,
        projectId,
        itemKind,
        itemId,
        location,
        conceptId,
        state: "confirmed",
        classifier: "human",
        confidence: 1,
      })
      .onConflictDoUpdate({
        target: [conceptPlacements.projectId, conceptPlacements.itemKind, conceptPlacements.itemId],
        set: {
          location,
          conceptId,
          state: "confirmed",
          classifier: "human",
          confidence: 1,
          lastError: null,
          revision: sql`${conceptPlacements.revision} + 1`,
          updatedAt: sql`now()`,
        },
      });
  });
}

/**
 * Merge `fromId` into `intoId`: the merged key (and any keys already aliased to it) become aliases
 * of the survivor, so a later sync resolves to it instead of recreating the merged concept.
 */
export async function mergeConcepts(
  orgId: string,
  projectId: string,
  fromId: string,
  intoId: string,
  by: string,
): Promise<void> {
  if (fromId === intoId) throw new ConceptError(400, "cannot merge a concept into itself");
  await withOrg(orgId, async (tx) => {
    const from = await liveConceptTx(tx, projectId, fromId);
    await liveConceptTx(tx, projectId, intoId);
    await tx
      .insert(conceptAliases)
      .values({ orgId, projectId, aliasKey: from.key, conceptId: intoId })
      .onConflictDoUpdate({ target: [conceptAliases.projectId, conceptAliases.aliasKey], set: { conceptId: intoId } });
    await tx.update(conceptAliases).set({ conceptId: intoId }).where(eq(conceptAliases.conceptId, fromId));
    await tx
      .update(conceptPlacements)
      .set({ conceptId: intoId, revision: sql`${conceptPlacements.revision} + 1`, updatedAt: sql`now()` })
      .where(eq(conceptPlacements.conceptId, fromId));
    // location overrides that named the merged concept now name the survivor
    await tx.execute(sql`
      UPDATE concept_overrides SET payload = jsonb_set(payload, '{conceptId}', to_jsonb(${intoId}::text))
      WHERE project_id = ${projectId} AND field = 'location' AND payload->>'conceptId' = ${fromId}`);
    await tx.execute(sql`
      INSERT INTO concept_refs (org_id, project_id, item_kind, item_id, concept_id, source, generation)
      SELECT org_id, project_id, item_kind, item_id, ${intoId}, source, generation FROM concept_refs
      WHERE concept_id = ${fromId}
      ON CONFLICT (item_kind, item_id, concept_id) DO NOTHING`);
    await tx.delete(conceptRefs).where(eq(conceptRefs.conceptId, fromId));
    await writeOverrideTx(tx, {
      orgId,
      projectId,
      targetKind: "concept",
      targetId: fromId,
      field: "merge",
      payload: { intoId },
      by,
    });
    await tx
      .update(concepts)
      .set({ retiredAt: sql`now()` })
      .where(eq(concepts.id, fromId));
  });
}

/* ───────────────────────────── domains + rules (each edit triggers a rebuild) ───────────────────────────── */

export async function createDomain(orgId: string, projectId: string, label: string): Promise<{ id: string }> {
  const clean = label.trim().slice(0, 80);
  if (!clean) throw new ConceptError(400, "label required");
  return withOrg(orgId, async (tx) => {
    await ensureConceptProjectTx(tx, orgId, projectId);
    const existing = await tx
      .select({ id: domains.id, position: domains.position })
      .from(domains)
      .where(eq(domains.projectId, projectId));
    if (existing.length >= MAX_DOMAINS) throw new ConceptError(409, `at most ${MAX_DOMAINS} domains per project`);
    const key =
      clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "domain";
    const [d] = await tx
      .insert(domains)
      .values({
        orgId,
        projectId,
        key: `${key}-${Date.now().toString(36)}`,
        label: clean,
        position: Math.max(-1, ...existing.map((e) => e.position)) + 1,
      })
      .returning({ id: domains.id });
    await enqueueRebuildTx(tx, orgId, projectId);
    return { id: d!.id };
  });
}

export async function updateDomain(
  orgId: string,
  projectId: string,
  domainId: string,
  patch: { label?: string; position?: number },
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const set: Partial<typeof domains.$inferInsert> = {};
    if (patch.label !== undefined) {
      const clean = patch.label.trim().slice(0, 80);
      if (!clean) throw new ConceptError(400, "label required");
      set.label = clean;
    }
    if (patch.position !== undefined) set.position = patch.position;
    const r = await tx
      .update(domains)
      .set(set)
      .where(and(eq(domains.id, domainId), eq(domains.projectId, projectId)))
      .returning({ id: domains.id });
    if (r.length === 0) throw new ConceptError(404, "domain not found");
    if (patch.label !== undefined) await enqueueRebuildTx(tx, orgId, projectId);
  });
}

/** Delete a domain: its concepts become unassigned (their domain pins are dropped) and re-filed. */
export async function deleteDomain(orgId: string, projectId: string, domainId: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const r = await tx
      .delete(domains)
      .where(and(eq(domains.id, domainId), eq(domains.projectId, projectId)))
      .returning({ id: domains.id });
    if (r.length === 0) throw new ConceptError(404, "domain not found");
    await tx.execute(sql`
      DELETE FROM concept_overrides WHERE project_id = ${projectId} AND target_kind = 'concept'
        AND field = 'domain' AND payload->>'domainId' = ${domainId}`);
    await tx
      .update(concepts)
      .set({ domainId: null, domainState: "pending", domainRevision: sql`${concepts.domainRevision} + 1` })
      .where(and(eq(concepts.projectId, projectId), eq(concepts.domainId, domainId)));
    await enqueueRebuildTx(tx, orgId, projectId);
  });
}

export async function setHttpRules(orgId: string, projectId: string, skip: string[]): Promise<void> {
  const clean = [...new Set(skip.map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  for (const s of clean) {
    const re = /^\/(.+)\/([a-z]*)$/.exec(s);
    if (re) {
      try {
        new RegExp(re[1]!);
      } catch {
        throw new ConceptError(400, `invalid pattern ${s}`);
      }
    }
  }
  await withOrg(orgId, async (tx) => {
    await ensureConceptProjectTx(tx, orgId, projectId);
    await tx
      .update(conceptProjects)
      .set({ httpRules: { skip: clean }, ruleVersion: sql`${conceptProjects.ruleVersion} + 1` })
      .where(eq(conceptProjects.projectId, projectId));
    await enqueueRebuildTx(tx, orgId, projectId);
  });
}

export async function requestRebuild(orgId: string, projectId: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await ensureConceptProjectTx(tx, orgId, projectId);
    await enqueueRebuildTx(tx, orgId, projectId);
  });
}
