/**
 * Concept ledger reads. Every response is bounded: the outline returns at most MAX_DOMAINS domains ×
 * OUTLINE_PAGE concepts, and every list pages through an opaque keyset cursor.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { conceptProjects, concepts, domains } from "../db/schema.js";
import { env } from "../env.js";
import { DEFAULT_HTTP_SKIP } from "./derive.js";
import { ConceptError, ensureConceptProjectTx } from "./concept-service.js";
import { getProjectRoleTx } from "../auth/permissions.js";

export const OUTLINE_PAGE = 100;
export const ITEM_PAGE = 50;

const rows = <T>(r: unknown): T[] => r as T[];

/** Human scope: project → "project-wide", repo id → repo name, topic prefix dropped. */
export const scopeLabelSql = sql`CASE d.scope_kind
  WHEN 'project' THEN 'project-wide'
  WHEN 'repo' THEN COALESCE((SELECT regexp_replace(r.git_remote, '^.*/', '') FROM repos r WHERE r.id::text = d.scope_ref), 'repo')
  WHEN 'topic' THEN regexp_replace(d.scope_ref, '^topic:', '')
  ELSE d.scope_ref END`;

export const encodeCursor = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
export function decodeCursor<T>(c: string | undefined): T | null {
  if (!c) return null;
  try {
    return JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as T;
  } catch {
    throw new ConceptError(400, "bad cursor");
  }
}

export interface ConceptCounts {
  surfaces: number;
  decisions: number;
  suggested: number;
  failed: number;
  conflicts: number;
}
export interface OutlineConcept {
  id: string;
  key: string;
  label: string;
  domainId: string | null;
  domainState: string;
  counts: ConceptCounts;
}

const total = (c: ConceptCounts) => c.surfaces + c.decisions;

/** Live concepts with counts. One grouped pass over placements (and open conflicts). */
async function conceptsWithCountsTx(tx: Tx, projectId: string): Promise<OutlineConcept[]> {
  const counts = rows<{ concept_id: string; s: number; d: number; sug: number; fail: number }>(
    await tx.execute(sql`
      SELECT concept_id,
        count(*) FILTER (WHERE item_kind = 'surface')::int AS s,
        count(*) FILTER (WHERE item_kind = 'decision')::int AS d,
        count(*) FILTER (WHERE state = 'suggested')::int AS sug,
        count(*) FILTER (WHERE state = 'failed')::int AS fail
      FROM concept_placements WHERE project_id = ${projectId} AND location = 'concept'
      GROUP BY concept_id`),
  );
  const conflicts = rows<{ concept_id: string; n: number }>(
    await tx.execute(sql`
      SELECT p.concept_id, count(DISTINCT c.id)::int AS n
      FROM conflicts c
      JOIN concept_placements p ON p.project_id = c.project_id AND p.item_kind = 'decision'
        AND p.item_id IN (c.constraint_decision_id, c.eng_decision_id) AND p.location = 'concept'
      WHERE c.project_id = ${projectId} AND c.status = 'open'
      GROUP BY p.concept_id`),
  );
  const byId = new Map(counts.map((c) => [c.concept_id, c]));
  const cById = new Map(conflicts.map((c) => [c.concept_id, c.n]));
  const live = await tx
    .select({
      id: concepts.id,
      key: concepts.key,
      label: concepts.label,
      domainId: concepts.domainId,
      domainState: concepts.domainState,
    })
    .from(concepts)
    .where(and(eq(concepts.projectId, projectId), isNull(concepts.retiredAt)));
  return live.map((c) => {
    const n = byId.get(c.id);
    return {
      ...c,
      counts: {
        surfaces: n?.s ?? 0,
        decisions: n?.d ?? 0,
        suggested: n?.sug ?? 0,
        failed: n?.fail ?? 0,
        conflicts: cById.get(c.id) ?? 0,
      },
    };
  });
}

type ConceptCursor = { n: number; id: string };

/** Keyset page: item count desc, then id asc. */
function pageConcepts(list: OutlineConcept[], cursor: ConceptCursor | null, size = OUTLINE_PAGE) {
  const sorted = [...list].sort((a, b) => total(b.counts) - total(a.counts) || a.id.localeCompare(b.id));
  const after = cursor
    ? sorted.filter((c) => total(c.counts) < cursor.n || (total(c.counts) === cursor.n && c.id > cursor.id))
    : sorted;
  const page = after.slice(0, size);
  const last = page[page.length - 1];
  return {
    concepts: page,
    nextCursor: after.length > size && last ? encodeCursor({ n: total(last.counts), id: last.id }) : null,
  };
}

export async function getOutline(orgId: string, projectId: string, memberId?: string) {
  return withOrg(orgId, async (tx) => {
    await ensureConceptProjectTx(tx, orgId, projectId);
    // ponytail: counts computed per request over all placements; add a counts table if 50k+ items gets slow
    const all = await conceptsWithCountsTx(tx, projectId);
    const ds = await tx
      .select()
      .from(domains)
      .where(eq(domains.projectId, projectId))
      .orderBy(domains.position, domains.label);
    const [g] = rows<{ pw: number; up: number }>(
      await tx.execute(sql`
        SELECT count(*) FILTER (WHERE location = 'project_wide')::int AS pw,
               count(*) FILTER (WHERE location = 'unplaced')::int AS up
        FROM concept_placements WHERE project_id = ${projectId}`),
    );
    const byDomain = new Map<string, OutlineConcept[]>();
    const unassigned: OutlineConcept[] = [];
    for (const c of all) {
      if (!c.domainId) unassigned.push(c);
      else (byDomain.get(c.domainId) ?? byDomain.set(c.domainId, []).get(c.domainId)!).push(c);
    }
    return {
      domains: ds.map((d) => {
        const list = byDomain.get(d.id) ?? [];
        const sum = (f: keyof ConceptCounts) => list.reduce((a, c) => a + c.counts[f], 0);
        return {
          id: d.id,
          label: d.label,
          counts: {
            concepts: list.length,
            items: list.reduce((a, c) => a + total(c.counts), 0),
            suggested: sum("suggested") + list.filter((c) => c.domainState === "suggested").length,
            failed: sum("failed"),
            conflicts: sum("conflicts"),
          },
          ...pageConcepts(list, null),
        };
      }),
      viewer: { role: memberId ? ((await getProjectRoleTx(tx, projectId, memberId)) ?? "member") : "member" },
      groups: {
        project_wide: { items: g?.pw ?? 0 },
        unplaced: { items: g?.up ?? 0 },
        unassigned_domain: { concepts: unassigned.length },
      },
    };
  });
}

export async function getOutlineDomain(orgId: string, projectId: string, domainId: string, cursor?: string) {
  return withOrg(orgId, async (tx) => {
    const all = await conceptsWithCountsTx(tx, projectId);
    return pageConcepts(
      all.filter((c) => c.domainId === domainId),
      decodeCursor<ConceptCursor>(cursor),
    );
  });
}

export interface GroupItem {
  itemKind: string;
  itemId: string;
  title: string;
  state: string;
  classifier: string | null;
  confidence: number | null;
  lastError: string | null;
  status: string | null;
}

type ItemCursor = { t: string; id: string };

/** Items of a virtual group (Project-wide / Needs placement), newest first. */
async function groupItemsTx(tx: Tx, projectId: string, location: string, cursor: ItemCursor | null) {
  const r = rows<{
    item_kind: string;
    item_id: string;
    state: string;
    classifier: string | null;
    confidence: number | null;
    last_error: string | null;
    updated_at: string;
    id: string;
    surface: string | null;
    rule_text: string | null;
    scope_ref: string | null;
    status: string | null;
  }>(
    await tx.execute(sql`
      SELECT p.id, p.item_kind, p.item_id, p.state, p.classifier, p.confidence, p.last_error, p.updated_at,
        s.surface, d.scope_ref, d.status, v.rule_text
      FROM concept_placements p
      LEFT JOIN surfaces s ON p.item_kind = 'surface' AND s.id = p.item_id
      LEFT JOIN decisions d ON p.item_kind = 'decision' AND d.id = p.item_id
      LEFT JOIN LATERAL (SELECT rule_text FROM decision_versions dv WHERE dv.decision_id = d.id
        ORDER BY dv.version DESC LIMIT 1) v ON true
      WHERE p.project_id = ${projectId} AND p.location = ${location}
        ${cursor ? sql`AND (p.updated_at, p.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : sql``}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ${ITEM_PAGE + 1}`),
  );
  const page = r.slice(0, ITEM_PAGE);
  const last = page[page.length - 1];
  return {
    items: page.map(
      (x): GroupItem => ({
        itemKind: x.item_kind,
        itemId: x.item_id,
        title: x.surface ?? x.rule_text?.slice(0, 200) ?? x.scope_ref ?? "(untitled)",
        state: x.state,
        classifier: x.classifier,
        confidence: x.confidence,
        lastError: x.last_error,
        status: x.status,
      }),
    ),
    nextCursor:
      r.length > ITEM_PAGE && last ? encodeCursor({ t: new Date(last.updated_at).toISOString(), id: last.id }) : null,
  };
}

export async function getOutlineGroup(orgId: string, projectId: string, group: string, cursor?: string) {
  return withOrg(orgId, async (tx) => {
    if (group === "project_wide" || group === "unplaced") {
      return {
        kind: "items" as const,
        ...(await groupItemsTx(tx, projectId, group, decodeCursor<ItemCursor>(cursor))),
      };
    }
    if (group === "unassigned_domain") {
      const all = await conceptsWithCountsTx(tx, projectId);
      return {
        kind: "concepts" as const,
        ...pageConcepts(
          all.filter((c) => !c.domainId),
          decodeCursor<ConceptCursor>(cursor),
        ),
      };
    }
    throw new ConceptError(404, "unknown group");
  });
}

/* ───────────────────────────── concept detail ───────────────────────────── */

async function conceptHeaderTx(tx: Tx, projectId: string, conceptId: string) {
  const c = (
    await tx
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, conceptId), eq(concepts.projectId, projectId)))
      .limit(1)
  )[0];
  if (!c) throw new ConceptError(404, "concept not found");
  const d = c.domainId ? (await tx.select().from(domains).where(eq(domains.id, c.domainId)).limit(1))[0] : undefined;
  const aliases = rows<{ alias_key: string }>(
    await tx.execute(sql`SELECT alias_key FROM concept_aliases WHERE concept_id = ${c.id} ORDER BY alias_key`),
  ).map((a) => a.alias_key);
  const [n] = rows<{ s: number; d: number }>(
    await tx.execute(sql`
      SELECT count(*) FILTER (WHERE item_kind = 'surface')::int AS s, count(*) FILTER (WHERE item_kind = 'decision')::int AS d
      FROM concept_placements WHERE concept_id = ${c.id} AND location = 'concept'`),
  );
  const [refs] = rows<{ n: number }>(
    await tx.execute(sql`
      SELECT count(*)::int AS n FROM concept_refs r WHERE r.concept_id = ${c.id} AND NOT EXISTS (
        SELECT 1 FROM concept_placements p WHERE p.item_kind = r.item_kind AND p.item_id = r.item_id AND p.concept_id = r.concept_id)`),
  );
  const pins = rows<{ field: string }>(
    await tx.execute(sql`SELECT field FROM concept_overrides WHERE target_kind = 'concept' AND target_id = ${c.id}`),
  ).map((p) => p.field);
  return {
    id: c.id,
    key: c.key,
    label: c.label,
    retired: Boolean(c.retiredAt),
    domain: d ? { id: d.id, label: d.label } : null,
    domainState: c.domainState,
    domainClassifier: c.domainClassifier,
    domainConfidence: c.domainConfidence,
    pinned: pins,
    aliases,
    counts: { surfaces: n?.s ?? 0, decisions: n?.d ?? 0, references: refs?.n ?? 0 },
  };
}

export async function getConcept(orgId: string, projectId: string, conceptId: string) {
  return withOrg(orgId, (tx) => conceptHeaderTx(tx, projectId, conceptId));
}

type DecCursor = { t: string; id: string };

export async function getConceptDecisions(orgId: string, projectId: string, conceptId: string, cursor?: string) {
  return withOrg(orgId, async (tx) => {
    await conceptHeaderTx(tx, projectId, conceptId);
    const cur = decodeCursor<DecCursor>(cursor);
    const r = rows<{
      id: string;
      scope_kind: string;
      scope_ref: string;
      status: string;
      origin: string;
      constraint_kind: string | null;
      decision_type: string;
      impact: number;
      current_version: number;
      created_at: string;
      rule_text: string | null;
      via: string;
      state: string | null;
      classifier: string | null;
      confidence: number | null;
      review_at: string | null;
      scope_label: string;
    }>(
      await tx.execute(sql`
        WITH members AS (
          SELECT item_id, 'primary' AS via FROM concept_placements
            WHERE concept_id = ${conceptId} AND item_kind = 'decision' AND location = 'concept'
          UNION
          SELECT r.item_id, 'reference' FROM concept_refs r
            WHERE r.concept_id = ${conceptId} AND r.item_kind = 'decision' AND NOT EXISTS (
              SELECT 1 FROM concept_placements p WHERE p.item_kind = 'decision' AND p.item_id = r.item_id AND p.concept_id = ${conceptId})
        )
        SELECT d.id, d.scope_kind, d.scope_ref, d.status, d.origin, d.constraint_kind, d.decision_type, d.impact,
          d.current_version, d.created_at, d.review_at, m.via, ${scopeLabelSql} AS scope_label, p.state, p.classifier, p.confidence, v.rule_text
        FROM members m JOIN decisions d ON d.id = m.item_id
        LEFT JOIN concept_placements p ON p.item_kind = 'decision' AND p.item_id = d.id
        LEFT JOIN LATERAL (SELECT rule_text FROM decision_versions dv WHERE dv.decision_id = d.id
          ORDER BY dv.version DESC LIMIT 1) v ON true
        WHERE d.project_id = ${projectId}
          ${cur ? sql`AND (d.created_at, d.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : sql``}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${ITEM_PAGE + 1}`),
    );
    // open conflicts touching this concept's decisions — pinned above the list (first page only)
    const conflicts = cur
      ? []
      : rows<{
          id: string;
          kind: string;
          surface: string;
          opened_at: string;
          constraint_decision_id: string;
          eng_decision_id: string | null;
          constraint_text: string | null;
          eng_text: string | null;
          constraint_kind: string | null;
        }>(
          await tx.execute(sql`
            SELECT c.id, c.kind, c.surface, c.opened_at, c.constraint_decision_id, c.eng_decision_id, cd.constraint_kind,
              (SELECT rule_text FROM decision_versions WHERE decision_id = c.constraint_decision_id ORDER BY version DESC LIMIT 1) AS constraint_text,
              (SELECT rule_text FROM decision_versions WHERE decision_id = c.eng_decision_id ORDER BY version DESC LIMIT 1) AS eng_text
            FROM conflicts c JOIN decisions cd ON cd.id = c.constraint_decision_id
            WHERE c.project_id = ${projectId} AND c.status = 'open' AND EXISTS (
              SELECT 1 FROM concept_placements p WHERE p.concept_id = ${conceptId} AND p.item_kind = 'decision'
                AND p.item_id IN (c.constraint_decision_id, c.eng_decision_id))
            ORDER BY c.opened_at DESC LIMIT 50`),
        ).map((c) => ({
          id: c.id,
          kind: c.kind,
          surface: c.surface,
          openedAt: c.opened_at,
          constraintKind: c.constraint_kind,
          constraint: { id: c.constraint_decision_id, ruleText: c.constraint_text },
          engineering: c.eng_decision_id ? { id: c.eng_decision_id, ruleText: c.eng_text } : null,
        }));
    const page = r.slice(0, ITEM_PAGE);
    const last = page[page.length - 1];
    return {
      conflicts,
      decisions: page.map((d) => ({
        id: d.id,
        scopeKind: d.scope_kind,
        scopeRef: d.scope_ref,
        scopeLabel: d.scope_label,
        status: d.status,
        origin: d.origin,
        constraintKind: d.constraint_kind,
        decisionType: d.decision_type,
        impact: d.impact,
        version: d.current_version,
        reviewAt: d.review_at,
        ruleText: d.rule_text,
        via: d.via,
        placement: { state: d.state, classifier: d.classifier, confidence: d.confidence },
      })),
      nextCursor:
        r.length > ITEM_PAGE && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
  });
}

type SurfCursor = { s: string; id: string };

export async function getConceptContracts(orgId: string, projectId: string, conceptId: string, cursor?: string) {
  return withOrg(orgId, async (tx) => {
    await conceptHeaderTx(tx, projectId, conceptId);
    const cur = decodeCursor<SurfCursor>(cursor);
    const r = rows<{
      id: string;
      surface: string;
      kind: string;
      repo_id: string;
      git_remote: string | null;
      return_type: string | null;
      state: string;
      classifier: string | null;
      history: number;
    }>(
      await tx.execute(sql`
        SELECT s.id, s.surface, s.kind, s.repo_id, rp.git_remote, s.return_type, p.state, p.classifier,
          (SELECT count(*)::int FROM contracts c WHERE c.surface_id = s.id) AS history
        FROM concept_placements p JOIN surfaces s ON s.id = p.item_id
        LEFT JOIN repos rp ON rp.id = s.repo_id
        WHERE p.concept_id = ${conceptId} AND p.item_kind = 'surface' AND p.location = 'concept'
          ${cur ? sql`AND (s.surface, s.id) > (${cur.s}, ${cur.id}::uuid)` : sql``}
        ORDER BY s.surface, s.id
        LIMIT ${ITEM_PAGE + 1}`),
    );
    const page = r.slice(0, ITEM_PAGE);
    const names = [...new Set(page.map((s) => s.surface))];
    const inList = (xs: string[]) => sql`(${sql.join(xs.map((n) => sql`${n}`), sql`, `)})`;
    // Consumers belong to a producer: the same canonical route in two repos is two contracts (D3).
    const consumers = names.length
      ? rows<{ produced_repo_id: string | null; produced_surface: string; n: number; remotes: string[] }>(
          await tx.execute(sql`
            SELECT e.produced_repo_id, e.produced_surface, count(DISTINCT e.consumer_repo_id)::int AS n,
              (array_agg(DISTINCT r.git_remote))[1:5] AS remotes
            FROM dependency_edges e LEFT JOIN repos r ON r.id = e.consumer_repo_id
            WHERE e.project_id = ${projectId} AND e.active AND e.produced_surface IN ${inList(names)}
            GROUP BY e.produced_repo_id, e.produced_surface`),
        )
      : [];
    // An edge with no recorded producer is attributed only when exactly one repo produces that surface.
    const producers = names.length
      ? rows<{ surface: string; n: number }>(
          await tx.execute(sql`
            SELECT surface, count(DISTINCT repo_id)::int AS n FROM surfaces
            WHERE project_id = ${projectId} AND removed_at IS NULL AND surface IN ${inList(names)} GROUP BY surface`),
        )
      : [];
    const soleProducer = new Set(producers.filter((x) => x.n === 1).map((x) => x.surface));
    // "Governed by" = BINDING rules for the surface or its whole repository; proposals and history
    // are shown separately with their status (D2).
    const remotes = [...new Set(page.map((s) => s.git_remote).filter((x): x is string => Boolean(x)))];
    // Capabilities govern a surface only through CONFIRMED governs edges (same rule as briefings).
    const capEdges = names.length
      ? rows<{ surface: string; cap: string }>(
          await tx.execute(sql`
            SELECT sn.ref AS surface, cn.ref AS cap FROM graph_nodes sn
            JOIN graph_edges e ON e.to_id = sn.id AND e.kind = 'governs' AND e.status = 'confirmed'
            JOIN graph_nodes cn ON cn.id = e.from_id AND cn.kind = 'capability'
            WHERE sn.project_id = ${projectId} AND sn.kind = 'surface' AND sn.ref IN ${inList(names)}`),
        )
      : [];
    const caps = [...new Set(capEdges.map((e) => e.cap))];
    const decisionsFor = names.length
      ? rows<{ scope_kind: string; scope_ref: string; id: string; status: string; origin: string; rule_text: string | null }>(
          await tx.execute(sql`
            SELECT d.scope_kind, d.scope_ref, d.id, d.status, d.origin,
              (SELECT rule_text FROM decision_versions WHERE decision_id = d.id ORDER BY version DESC LIMIT 1) AS rule_text
            FROM decisions d
            WHERE d.project_id = ${projectId} AND d.status NOT IN ('rejected')
              AND ((d.scope_kind = 'surface' AND d.scope_ref IN ${inList(names)})
                ${remotes.length ? sql`OR (d.scope_kind = 'repo' AND d.status = 'binding' AND d.scope_ref IN ${inList(remotes)})` : sql``}
                ${caps.length ? sql`OR (d.scope_kind = 'capability' AND d.status = 'binding' AND d.scope_ref IN ${inList(caps)})` : sql``})
            ORDER BY d.created_at DESC`),
        )
      : [];
    const projectWide = rows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM decisions WHERE project_id = ${projectId} AND scope_kind = 'project' AND status = 'binding'`),
    )[0]?.n ?? 0;
    const last = page[page.length - 1];
    return {
      projectWideBinding: projectWide,
      contracts: page.map((s) => {
        const c =
          consumers.find((x) => x.produced_repo_id === s.repo_id && x.produced_surface === s.surface) ??
          (soleProducer.has(s.surface) ? consumers.find((x) => x.produced_repo_id === null && x.produced_surface === s.surface) : undefined);
        const myCaps = new Set(capEdges.filter((e) => e.surface === s.surface).map((e) => e.cap));
        const mine = decisionsFor.filter(
          (d) =>
            (d.scope_kind === "surface" && d.scope_ref === s.surface) ||
            (d.scope_kind === "repo" && d.scope_ref === s.git_remote) ||
            (d.scope_kind === "capability" && myCaps.has(d.scope_ref)),
        );
        const toRow = (g: (typeof mine)[number]) => ({
          id: g.id,
          status: g.status,
          origin: g.origin,
          ruleText: g.rule_text,
          via: g.scope_kind === "repo" ? "repository" : g.scope_kind === "capability" ? `capability ${g.scope_ref}` : "surface",
        });
        return {
          id: s.id,
          surface: s.surface,
          kind: s.kind,
          repo: { id: s.repo_id, gitRemote: s.git_remote },
          returnType: s.return_type,
          placement: { state: s.state, classifier: s.classifier },
          consumers: { count: c?.n ?? 0, sample: (c?.remotes ?? []).filter(Boolean) },
          governing: mine.filter((g) => g.status === "binding").slice(0, 5).map(toRow),
          related: mine.filter((g) => g.status !== "binding").slice(0, 5).map(toRow),
          historyCount: s.history,
        };
      }),
      nextCursor: r.length > ITEM_PAGE && last ? encodeCursor({ s: last.surface, id: last.id }) : null,
    };
  });
}

export async function getConceptSources(orgId: string, projectId: string, conceptId: string) {
  return withOrg(orgId, async (tx) => {
    await conceptHeaderTx(tx, projectId, conceptId);
    const docs = rows<{
      id: string;
      title: string | null;
      url: string | null;
      state: string;
      tool: string;
      constraints: number;
    }>(
      await tx.execute(sql`
        SELECT sd.id, sd.title, sd.url, sd.state, sd.tool, count(DISTINCT d.id)::int AS constraints
        FROM concept_placements p
        JOIN decisions d ON d.id = p.item_id AND d.origin = 'document'
        JOIN decision_versions dv ON dv.decision_id = d.id
        JOIN source_documents sd ON sd.id::text = dv.provenance->>'documentId'
        WHERE p.concept_id = ${conceptId} AND p.item_kind = 'decision' AND sd.project_id = ${projectId}
        GROUP BY sd.id ORDER BY constraints DESC, sd.title LIMIT ${ITEM_PAGE}`),
    );
    const provenances = rows<{ source: string; url: string | null; external_id: string | null; decision_id: string }>(
      await tx.execute(sql`
        SELECT DISTINCT ON (dp.source, dp.external_id) dp.source, dp.url, dp.external_id, dp.decision_id
        FROM concept_placements p JOIN decision_provenances dp ON dp.decision_id = p.item_id
        WHERE p.concept_id = ${conceptId} AND p.item_kind = 'decision'
        ORDER BY dp.source, dp.external_id LIMIT ${ITEM_PAGE}`),
    );
    return {
      documents: docs,
      provenances: provenances.map((p) => ({
        source: p.source,
        url: p.url,
        externalId: p.external_id,
        decisionId: p.decision_id,
      })),
    };
  });
}

export async function getSurfaceHistory(orgId: string, projectId: string, surfaceId: string, cursor?: string) {
  return withOrg(orgId, async (tx) => {
    const cur = decodeCursor<DecCursor>(cursor);
    const r = rows<{
      id: string;
      version: number;
      delta: unknown;
      verified_against: string | null;
      verification_status: string;
      created_at: string;
    }>(
      await tx.execute(sql`
        SELECT c.id, c.version, c.delta, c.verified_against, c.verification_status, c.created_at
        FROM contracts c JOIN surfaces s ON s.id = c.surface_id
        WHERE c.surface_id = ${surfaceId} AND s.project_id = ${projectId}
          ${cur ? sql`AND (c.created_at, c.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : sql``}
        ORDER BY c.created_at DESC, c.id DESC LIMIT ${ITEM_PAGE + 1}`),
    );
    const page = r.slice(0, ITEM_PAGE);
    const last = page[page.length - 1];
    return {
      history: page.map((c) => ({
        id: c.id,
        version: c.version,
        delta: c.delta,
        verifiedAgainst: c.verified_against,
        verificationStatus: c.verification_status,
        createdAt: c.created_at,
      })),
      nextCursor:
        r.length > ITEM_PAGE && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
  });
}

/** Settings: domains, HTTP rules, last rebuild progress, provider health. */
export async function getConceptSettings(orgId: string, projectId: string) {
  return withOrg(orgId, async (tx) => {
    await ensureConceptProjectTx(tx, orgId, projectId);
    const p = (await tx.select().from(conceptProjects).where(eq(conceptProjects.projectId, projectId)).limit(1))[0]!;
    const ds = rows<{ id: string; key: string; label: string; position: number; concepts: number }>(
      await tx.execute(sql`
        SELECT d.id, d.key, d.label, d.position,
          (SELECT count(*)::int FROM concepts c WHERE c.domain_id = d.id AND c.retired_at IS NULL) AS concepts
        FROM domains d WHERE d.project_id = ${projectId} ORDER BY d.position, d.label`),
    );
    const rb = rows<{
      id: string;
      phase: string;
      started_at: string;
      finished_at: string | null;
      total: number;
      satisfied: number;
    }>(
      await tx.execute(sql`
        SELECT r.id, r.phase, r.started_at, r.finished_at,
          (SELECT count(*)::int FROM concept_rebuild_items i WHERE i.rebuild_id = r.id) AS total,
          (SELECT count(*)::int FROM concept_rebuild_items i WHERE i.rebuild_id = r.id AND i.satisfied_at IS NOT NULL) AS satisfied
        FROM concept_rebuilds r WHERE r.project_id = ${projectId} ORDER BY r.started_at DESC LIMIT 1`),
    )[0];
    const [q] = rows<{ pending: number; no_provider: number; failed: number; rebuild_live: number }>(
      await tx.execute(sql`
        SELECT count(*) FILTER (WHERE state IN ('queued', 'running') AND kind <> 'rebuild')::int AS pending,
               count(*) FILTER (WHERE state = 'failed' AND last_error = 'no_provider')::int AS no_provider,
               count(*) FILTER (WHERE state = 'failed' AND last_error IS DISTINCT FROM 'no_provider')::int AS failed,
               count(*) FILTER (WHERE state IN ('queued', 'running') AND kind = 'rebuild')::int AS rebuild_live
        FROM concept_tasks WHERE project_id = ${projectId}`),
    );
    return {
      domains: ds,
      httpRules: {
        skip: p.httpRules?.skip ?? DEFAULT_HTTP_SKIP,
        isDefault: !p.httpRules?.skip,
        defaults: DEFAULT_HTTP_SKIP,
      },
      ruleVersion: p.ruleVersion,
      rebuild: rb
        ? {
            phase: rb.phase,
            startedAt: rb.started_at,
            finishedAt: rb.finished_at,
            total: rb.total,
            satisfied: rb.satisfied,
            queued: (q?.rebuild_live ?? 0) > 0,
          }
        : { phase: null, queued: (q?.rebuild_live ?? 0) > 0 },
      queue: { pending: q?.pending ?? 0, noProvider: q?.no_provider ?? 0, failed: q?.failed ?? 0 },
      providers: { jev: Boolean(env.TYPESAFE_API_KEY), claude: Boolean(env.ANTHROPIC_API_KEY) },
    };
  });
}
