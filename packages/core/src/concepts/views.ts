/**
 * Read models for the new dashboard shell: the ranked Inbox, the paginated Ledger tabs, the Cmd-K
 * search and the bounded concept graph. All bounded and cursor-paginated.
 */
import { sql } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { getProjectRoleTx } from "../auth/permissions.js";
import { ConceptError } from "./concept-service.js";
import { decodeCursor, encodeCursor, ITEM_PAGE, scopeLabelSql } from "./read.js";

const rows = <T>(r: unknown): T[] => r as T[];
const DAY = 86_400_000;

/* ───────────────────────────── Inbox ───────────────────────────── */

export type InboxKind = "conflict" | "proposal" | "ratification" | "question" | "task" | "review_due" | "placement";

export interface InboxItem {
  kind: InboxKind;
  id: string;
  severity: 0 | 1 | 2 | 3;
  score: number;
  title: string;
  detail: string | null;
  impact: number;
  createdAt: string;
  conceptId: string | null;
  conceptLabel: string | null;
  meta: Record<string, unknown>;
}

type InboxCursor = { asOf: number; maxImpact: number; sev: number; score: number; id: string };

export const AGE_CAP_DAYS = 14;

/** Within-severity score: 0.7 impact + 0.3 bounded age. Age can never cross a severity level. */
export function inboxScore(impact: number, createdAt: Date, asOf: number, maxImpact: number): number {
  const impactNorm = maxImpact > 0 ? Math.log1p(Math.max(0, impact)) / Math.log1p(maxImpact) : 0;
  const ageNorm = Math.min(Math.max(0, (asOf - createdAt.getTime()) / DAY), AGE_CAP_DAYS) / AGE_CAP_DAYS;
  return 0.7 * impactNorm + 0.3 * ageNorm;
}

/** Stable order: severity desc, score desc, id asc. */
export function compareInbox(
  a: { severity: number; score: number; id: string },
  b: { severity: number; score: number; id: string },
): number {
  return b.severity - a.severity || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function getInbox(
  orgId: string,
  projectId: string,
  memberId: string,
  opts: { cursor?: string; kinds?: InboxKind[]; housekeeping?: boolean } = {},
) {
  const cur = decodeCursor<InboxCursor>(opts.cursor);
  const asOf = cur?.asOf ?? Date.now();
  return withOrg(orgId, async (tx) => {
    const concept = sql`(SELECT json_build_object('id', c.id, 'label', c.label) FROM concept_placements p
      JOIN concepts c ON c.id = p.concept_id WHERE p.item_kind = 'decision' AND p.item_id = d.id LIMIT 1)`;
    const latest = sql`(SELECT rule_text FROM decision_versions v WHERE v.decision_id = d.id ORDER BY v.version DESC LIMIT 1)`;
    type Row = {
      id: string;
      created_at: string;
      impact: number;
      status: string;
      origin: string;
      constraint_kind: string | null;
      current_version: number;
      scope_ref: string;
      review_at: string | null;
      expires_at: string | null;
      rule_text: string | null;
      concept: { id: string; label: string } | null;
      scope_label: string;
    };
    const decisionRows = rows<Row>(
      await tx.execute(sql`
        SELECT d.id, d.created_at, d.impact, d.status, d.origin, d.constraint_kind, d.current_version, d.scope_ref, d.review_at, d.expires_at,
          ${latest} AS rule_text, ${concept} AS concept, ${scopeLabelSql} AS scope_label
        FROM decisions d
        WHERE d.project_id = ${projectId} AND (
          d.status IN ('proposed', 'open')
          OR (d.status = 'binding' AND (
            (d.review_at IS NOT NULL AND d.review_at <= now() + interval '7 days')
            OR (d.expires_at IS NOT NULL AND d.expires_at <= now() + interval '7 days'))))`),
    );
    const conflictRows = rows<{
      id: string;
      kind: string;
      surface: string;
      opened_at: string;
      constraint_kind: string | null;
      impact: number;
      constraint_decision_id: string;
      eng_decision_id: string | null;
      constraint_text: string | null;
      eng_text: string | null;
      concept: { id: string; label: string } | null;
    }>(
      await tx.execute(sql`
        SELECT c.id, c.kind, c.surface, c.opened_at, d.constraint_kind, d.impact, c.constraint_decision_id, c.eng_decision_id,
          (SELECT rule_text FROM decision_versions v WHERE v.decision_id = c.constraint_decision_id ORDER BY v.version DESC LIMIT 1) AS constraint_text,
          (SELECT rule_text FROM decision_versions v WHERE v.decision_id = c.eng_decision_id ORDER BY v.version DESC LIMIT 1) AS eng_text,
          ${concept} AS concept
        FROM conflicts c JOIN decisions d ON d.id = c.constraint_decision_id
        WHERE c.project_id = ${projectId} AND c.status = 'open'`),
    );
    const questionRows = rows<{
      id: string;
      body: string;
      urgent: boolean;
      created_at: string;
      scope_ref: string | null;
    }>(
      await tx.execute(sql`
        SELECT id, body, urgent, created_at, scope_ref FROM questions
        WHERE project_id = ${projectId} AND status = 'open'`),
    );
    const taskRows = rows<{
      id: string;
      title: string;
      created_at: string;
      run_state: string;
      approver: string | null;
      delegated_to: string | null;
    }>(
      await tx.execute(sql`
        SELECT id, title, created_at, run_state, approver, delegated_to FROM tasks
        WHERE project_id = ${projectId} AND status = 'open'
          AND ((approver = ${memberId} AND run_state = 'queued') OR delegated_to = ${memberId})`),
    );
    const placementRows = opts.housekeeping
      ? rows<{
          id: string;
          item_id: string;
          state: string;
          last_error: string | null;
          updated_at: string;
          rule_text: string | null;
          concept_id: string | null;
          concept_label: string | null;
          classifier: string | null;
          confidence: number | null;
        }>(
          await tx.execute(sql`
            SELECT p.id, p.item_id, p.state, p.last_error, p.updated_at, p.concept_id, p.classifier, p.confidence,
              (SELECT label FROM concepts c WHERE c.id = p.concept_id) AS concept_label,
              (SELECT rule_text FROM decision_versions v WHERE v.decision_id = p.item_id ORDER BY v.version DESC LIMIT 1) AS rule_text
            FROM concept_placements p
            WHERE p.project_id = ${projectId} AND p.item_kind = 'decision' AND p.state IN ('suggested', 'failed')`),
        )
      : [];
    const [hk] = rows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM concept_placements
        WHERE project_id = ${projectId} AND item_kind = 'decision' AND state IN ('suggested', 'failed')`),
    );

    // ponytail: ranked in memory over the open set; move scoring into SQL if open items reach ~50k
    const maxImpact =
      cur?.maxImpact ?? Math.max(0, ...decisionRows.map((d) => d.impact), ...conflictRows.map((c) => c.impact));
    const items: Omit<InboxItem, "score">[] = [];
    const soon = asOf + 7 * DAY;
    for (const d of decisionRows) {
      const base = {
        id: d.id,
        title: d.rule_text ?? d.scope_ref,
        impact: d.impact,
        createdAt: d.created_at,
        conceptId: d.concept?.id ?? null,
        conceptLabel: d.concept?.label ?? null,
      };
      if (d.status === "binding") {
        const due = [d.review_at, d.expires_at].filter(Boolean).map((x) => new Date(x!).getTime());
        if (due.some((t) => t <= soon)) {
          items.push({
            ...base,
            kind: "review_due",
            severity: 3,
            detail: d.scope_label,
            meta: { reviewAt: d.review_at, expiresAt: d.expires_at, origin: d.origin },
          });
        }
        continue;
      }
      const kind: InboxKind = d.origin === "document" ? "ratification" : "proposal";
      items.push({
        ...base,
        kind,
        severity: d.impact >= 3 ? 2 : 1,
        detail: d.scope_label,
        meta: { status: d.status, origin: d.origin, constraintKind: d.constraint_kind, version: d.current_version },
      });
    }
    for (const c of conflictRows) {
      const severity = c.constraint_kind === "launch_gate" ? 3 : c.kind === "drift" ? 2 : 1;
      items.push({
        kind: "conflict",
        id: c.id,
        severity,
        title: c.constraint_text ?? c.surface,
        detail: c.eng_text,
        impact: c.impact,
        createdAt: c.opened_at,
        conceptId: c.concept?.id ?? null,
        conceptLabel: c.concept?.label ?? null,
        meta: {
          conflictKind: c.kind,
          surface: c.surface,
          constraintKind: c.constraint_kind,
          decisionId: c.constraint_decision_id,
          engDecisionId: c.eng_decision_id,
        },
      });
    }
    for (const q of questionRows) {
      items.push({
        kind: "question",
        id: q.id,
        severity: q.urgent ? 3 : 1,
        title: q.body,
        detail: q.scope_ref,
        impact: 0,
        createdAt: q.created_at,
        conceptId: null,
        conceptLabel: null,
        meta: { urgent: q.urgent },
      });
    }
    for (const t of taskRows) {
      const approving = t.approver === memberId && t.run_state === "queued";
      items.push({
        kind: "task",
        id: t.id,
        severity: approving ? 3 : 1,
        title: t.title,
        detail: approving ? "awaiting your approval" : "delegated to you",
        impact: 0,
        createdAt: t.created_at,
        conceptId: null,
        conceptLabel: null,
        meta: { runState: t.run_state, approving },
      });
    }
    for (const p of placementRows) {
      items.push({
        kind: "placement",
        id: p.id,
        severity: 0,
        title: p.rule_text ?? "(decision)",
        detail:
          p.state === "failed"
            ? `needs placement (${p.last_error ?? "failed"})`
            : `suggested by ${p.classifier ?? "model"}${p.confidence != null ? ` ${Math.round(p.confidence * 100)}%` : ""}`,
        impact: 0,
        createdAt: p.updated_at,
        conceptId: p.concept_id,
        conceptLabel: p.concept_label,
        meta: { itemId: p.item_id, state: p.state },
      });
    }

    const scored = items
      .filter((i) => !opts.kinds?.length || opts.kinds.includes(i.kind))
      .map((i) => ({ ...i, score: inboxScore(i.impact, new Date(i.createdAt), asOf, maxImpact) }))
      .sort(compareInbox);
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    const after = cur
      ? scored.filter((i) => compareInbox(i, { severity: cur.sev, score: cur.score, id: cur.id }) > 0)
      : scored;
    const page = after.slice(0, ITEM_PAGE);
    const last = page[page.length - 1];
    return {
      items: page,
      counts,
      housekeeping: hk?.n ?? 0,
      viewer: { role: (await getProjectRoleTx(tx, projectId, memberId)) ?? "member" },
      nextCursor:
        after.length > ITEM_PAGE && last
          ? encodeCursor({ asOf, maxImpact, sev: last.severity, score: last.score, id: last.id } satisfies InboxCursor)
          : null,
    };
  });
}

/* ───────────────────────────── Ledger tabs ───────────────────────────── */

export type LedgerTab = "decisions" | "contracts" | "sources" | "questions" | "tasks";

export async function getLedger(
  orgId: string,
  projectId: string,
  tab: LedgerTab,
  opts: { cursor?: string; q?: string; status?: string; origin?: string; conceptId?: string } = {},
) {
  const like = opts.q ? `%${opts.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const cur = decodeCursor<{ k: string; id: string }>(opts.cursor);
  return withOrg(orgId, async (tx) => {
    const concept = (
      kind: string,
      idCol: ReturnType<typeof sql>,
    ) => sql`(SELECT json_build_object('id', c.id, 'label', c.label, 'key', c.key)
      FROM concept_placements p JOIN concepts c ON c.id = p.concept_id
      WHERE p.item_kind = ${kind} AND p.item_id = ${idCol} LIMIT 1)`;
    const conceptFilter = (kind: string, idCol: ReturnType<typeof sql>) =>
      opts.conceptId
        ? sql`AND EXISTS (SELECT 1 FROM concept_placements p WHERE p.item_kind = ${kind} AND p.item_id = ${idCol} AND p.concept_id = ${opts.conceptId})`
        : sql``;
    const page = <T extends { id: string }>(r: T[], key: (x: T) => string) => {
      const p = r.slice(0, ITEM_PAGE);
      const last = p[p.length - 1];
      return { rows: p, nextCursor: r.length > ITEM_PAGE && last ? encodeCursor({ k: key(last), id: last.id }) : null };
    };
    switch (tab) {
      case "decisions": {
        const r = rows<{
          id: string;
          created_at: string;
          scope_kind: string;
          scope_ref: string;
          status: string;
          origin: string;
          decision_type: string;
          constraint_kind: string | null;
          impact: number;
          current_version: number;
          scope_label: string;
          rule_text: string | null;
          concept: unknown;
        }>(
          await tx.execute(sql`
            SELECT d.id, d.created_at, d.scope_kind, d.scope_ref, d.status, d.origin, d.decision_type, d.constraint_kind,
              d.impact, d.current_version, ${scopeLabelSql} AS scope_label,
              (SELECT rule_text FROM decision_versions v WHERE v.decision_id = d.id ORDER BY v.version DESC LIMIT 1) AS rule_text,
              ${concept("decision", sql`d.id`)} AS concept
            FROM decisions d
            WHERE d.project_id = ${projectId}
              ${opts.status ? sql`AND d.status = ${opts.status}` : sql``}
              ${opts.origin ? sql`AND d.origin = ${opts.origin}` : sql``}
              ${like ? sql`AND (d.scope_ref ILIKE ${like} OR EXISTS (SELECT 1 FROM decision_versions v WHERE v.decision_id = d.id AND v.rule_text ILIKE ${like}))` : sql``}
              ${conceptFilter("decision", sql`d.id`)}
              ${cur ? sql`AND (d.created_at, d.id) < (${cur.k}::timestamptz, ${cur.id}::uuid)` : sql``}
            ORDER BY d.created_at DESC, d.id DESC LIMIT ${ITEM_PAGE + 1}`),
        );
        return page(r, (x) => new Date(x.created_at).toISOString());
      }
      case "contracts": {
        const r = rows<{
          id: string;
          surface: string;
          kind: string;
          git_remote: string | null;
          consumers: number;
          governing: number;
          changes: number;
          concept: unknown;
        }>(
          await tx.execute(sql`
            SELECT s.id, s.surface, s.kind, rp.git_remote,
              (SELECT count(DISTINCT e.consumer_repo_id)::int FROM dependency_edges e
                WHERE e.project_id = s.project_id AND e.active AND e.produced_surface = s.surface) AS consumers,
              (SELECT count(*)::int FROM decisions d WHERE d.project_id = s.project_id AND d.scope_kind = 'surface'
                AND d.scope_ref = s.surface AND d.status NOT IN ('rejected', 'superseded')) AS governing,
              (SELECT count(*)::int FROM contracts c WHERE c.surface_id = s.id) AS changes,
              ${concept("surface", sql`s.id`)} AS concept
            FROM surfaces s LEFT JOIN repos rp ON rp.id = s.repo_id
            WHERE s.project_id = ${projectId}
              ${like ? sql`AND s.surface ILIKE ${like}` : sql``}
              ${conceptFilter("surface", sql`s.id`)}
              ${cur ? sql`AND (s.surface, s.id) > (${cur.k}, ${cur.id}::uuid)` : sql``}
            ORDER BY s.surface, s.id LIMIT ${ITEM_PAGE + 1}`),
        );
        return page(r, (x) => x.surface);
      }
      case "sources": {
        const r = rows<{
          id: string;
          title: string | null;
          url: string | null;
          tool: string;
          state: string;
          created_at: string;
          constraints: number;
        }>(
          await tx.execute(sql`
            SELECT sd.id, sd.title, sd.url, sd.tool, sd.state, sd.created_at,
              (SELECT count(DISTINCT dv.decision_id)::int FROM decision_versions dv WHERE dv.provenance->>'documentId' = sd.id::text) AS constraints
            FROM source_documents sd
            WHERE sd.project_id = ${projectId}
              ${like ? sql`AND sd.title ILIKE ${like}` : sql``}
              ${cur ? sql`AND (sd.created_at, sd.id) < (${cur.k}::timestamptz, ${cur.id}::uuid)` : sql``}
            ORDER BY sd.created_at DESC, sd.id DESC LIMIT ${ITEM_PAGE + 1}`),
        );
        return page(r, (x) => new Date(x.created_at).toISOString());
      }
      case "questions": {
        const r = rows<{
          id: string;
          body: string;
          status: string;
          urgent: boolean;
          scope_ref: string | null;
          created_at: string;
          answers: number;
        }>(
          await tx.execute(sql`
            SELECT q.id, q.body, q.status, q.urgent, q.scope_ref, q.created_at,
              (SELECT count(*)::int FROM answers a WHERE a.question_id = q.id) AS answers
            FROM questions q WHERE q.project_id = ${projectId}
              ${like ? sql`AND q.body ILIKE ${like}` : sql``}
              ${opts.status ? sql`AND q.status = ${opts.status}` : sql``}
              ${cur ? sql`AND (q.created_at, q.id) < (${cur.k}::timestamptz, ${cur.id}::uuid)` : sql``}
            ORDER BY q.created_at DESC, q.id DESC LIMIT ${ITEM_PAGE + 1}`),
        );
        return page(r, (x) => new Date(x.created_at).toISOString());
      }
      case "tasks": {
        const r = rows<{
          id: string;
          title: string;
          status: string;
          run_state: string;
          created_at: string;
          delegated_to: string | null;
        }>(
          await tx.execute(sql`
            SELECT t.id, t.title, t.status, t.run_state, t.created_at, t.delegated_to FROM tasks t
            WHERE t.project_id = ${projectId}
              ${like ? sql`AND t.title ILIKE ${like}` : sql``}
              ${opts.status ? sql`AND t.status = ${opts.status}` : sql``}
              ${cur ? sql`AND (t.created_at, t.id) < (${cur.k}::timestamptz, ${cur.id}::uuid)` : sql``}
            ORDER BY t.created_at DESC, t.id DESC LIMIT ${ITEM_PAGE + 1}`),
        );
        return page(r, (x) => new Date(x.created_at).toISOString());
      }
      default:
        throw new ConceptError(404, "unknown tab");
    }
  });
}

/* ───────────────────────────── Cmd-K search ───────────────────────────── */

export async function searchProject(orgId: string, projectId: string, q: string) {
  const term = q.trim().slice(0, 100);
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return withOrg(orgId, async (tx) => {
    const conceptsOut = rows<{ id: string; label: string; key: string }>(
      await tx.execute(sql`
        SELECT id, label, key FROM concepts WHERE project_id = ${projectId} AND retired_at IS NULL
          ${term ? sql`AND (label ILIKE ${like} OR key ILIKE ${like})` : sql``}
        ORDER BY (lower(label) = lower(${term})) DESC, length(key), key LIMIT 8`),
    );
    if (!term) return { concepts: conceptsOut, surfaces: [], decisions: [] };
    const surfacesOut = rows<{ id: string; surface: string; concept_id: string | null }>(
      await tx.execute(sql`
        SELECT s.id, s.surface, p.concept_id FROM surfaces s
        LEFT JOIN concept_placements p ON p.item_kind = 'surface' AND p.item_id = s.id
        WHERE s.project_id = ${projectId} AND s.surface ILIKE ${like} ORDER BY length(s.surface), s.surface LIMIT 8`),
    );
    const decisionsOut = rows<{ id: string; rule_text: string; status: string; concept_id: string | null }>(
      await tx.execute(sql`
        SELECT DISTINCT ON (d.id) d.id, v.rule_text, d.status, p.concept_id FROM decisions d
        JOIN decision_versions v ON v.decision_id = d.id AND v.version = d.current_version
        LEFT JOIN concept_placements p ON p.item_kind = 'decision' AND p.item_id = d.id
        WHERE d.project_id = ${projectId} AND (v.rule_text ILIKE ${like} OR d.scope_ref ILIKE ${like})
        ORDER BY d.id LIMIT 8`),
    );
    return {
      concepts: conceptsOut,
      surfaces: surfacesOut.map((s) => ({ id: s.id, surface: s.surface, conceptId: s.concept_id })),
      decisions: decisionsOut.map((d) => ({
        id: d.id,
        ruleText: d.rule_text,
        status: d.status,
        conceptId: d.concept_id,
      })),
    };
  });
}

/* ───────────────────────────── bounded graph ───────────────────────────── */

export const GRAPH_CONCEPTS_PAGE = 50;
export const GRAPH_EDGE_CAP = 500;

/**
 * Domains (collapsed) + at most one expanded domain's concepts. Item-level edges are lifted to the
 * nearest VISIBLE node (a concept inside a collapsed domain → that domain), merged by
 * (from, to, kind), weighted by DISTINCT underlying records, self-loops dropped, heaviest 500 kept.
 * Dependency edges are deliberately absent: dependency_edges attribute consumers to repos, not
 * surfaces, so concept→concept dependency would be invented.
 */
export const GRAPH_ITEMS_CAP = 40;

export async function getGraph(orgId: string, projectId: string, expand?: string, cursor?: string, focus?: string) {
  const cur = decodeCursor<{ offset: number }>(cursor);
  return withOrg(orgId, async (tx) => {
    // per-concept decision + open-conflict counts, so collapsed nodes still show where the heat is
    const counts = rows<{ concept_id: string; domain_id: string | null; decisions: number; conflicts: number }>(
      await tx.execute(sql`
        SELECT c.id AS concept_id, c.domain_id,
          (SELECT count(*)::int FROM concept_placements p WHERE p.concept_id = c.id AND p.item_kind = 'decision') AS decisions,
          (SELECT count(DISTINCT f.id)::int FROM conflicts f JOIN concept_placements p
             ON p.item_kind = 'decision' AND p.item_id IN (f.constraint_decision_id, f.eng_decision_id) AND p.concept_id = c.id
           WHERE f.project_id = c.project_id AND f.status = 'open') AS conflicts
        FROM concepts c WHERE c.project_id = ${projectId} AND c.retired_at IS NULL`),
    );
    const byConcept = new Map(counts.map((c) => [c.concept_id, c]));
    const domainSum = (domainId: string | null) =>
      counts
        .filter((c) => c.domain_id === domainId)
        .reduce((a, c) => ({ decisions: a.decisions + c.decisions, conflicts: a.conflicts + c.conflicts }), {
          decisions: 0,
          conflicts: 0,
        });
    const ds = rows<{ id: string; label: string; concepts: number }>(
      await tx.execute(sql`
        SELECT d.id, d.label, (SELECT count(*)::int FROM concepts c WHERE c.domain_id = d.id AND c.retired_at IS NULL) AS concepts
        FROM domains d WHERE d.project_id = ${projectId} ORDER BY d.position, d.label`),
    );
    const [un] = rows<{ n: number }>(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM concepts WHERE project_id = ${projectId} AND retired_at IS NULL AND domain_id IS NULL`,
      ),
    );
    const UNASSIGNED = "unassigned";
    const offset = cur?.offset ?? 0;
    const expanded = expand
      ? rows<{ id: string; label: string; key: string; items: number; conflicts: number }>(
          await tx.execute(sql`
            SELECT c.id, c.label, c.key,
              (SELECT count(*)::int FROM concept_placements p WHERE p.concept_id = c.id) AS items,
              0 AS conflicts
            FROM concepts c
            WHERE c.project_id = ${projectId} AND c.retired_at IS NULL
              AND ${expand === UNASSIGNED ? sql`c.domain_id IS NULL` : sql`c.domain_id = ${expand}`}
            ORDER BY items DESC, c.id LIMIT ${GRAPH_CONCEPTS_PAGE + 1} OFFSET ${offset}`),
        )
      : [];
    const shown = expanded.slice(0, GRAPH_CONCEPTS_PAGE);
    const shownIds = new Set(shown.map((c) => c.id));
    // third level: the focused concept's decisions (conflicting ones first), as item nodes
    const focusOn = focus && shownIds.has(focus) ? focus : undefined;
    const items = focusOn
      ? rows<{ id: string; status: string; origin: string; rule_text: string | null; in_conflict: boolean }>(
          await tx.execute(sql`
            SELECT d.id, d.status, d.origin,
              (SELECT rule_text FROM decision_versions v WHERE v.decision_id = d.id ORDER BY v.version DESC LIMIT 1) AS rule_text,
              EXISTS (SELECT 1 FROM conflicts f WHERE f.status = 'open' AND d.id IN (f.constraint_decision_id, f.eng_decision_id)) AS in_conflict
            FROM concept_placements p JOIN decisions d ON d.id = p.item_id
            WHERE p.concept_id = ${focusOn} AND p.item_kind = 'decision' AND d.status NOT IN ('rejected')
            ORDER BY in_conflict DESC, (d.status = 'binding') DESC, d.created_at DESC
            LIMIT ${GRAPH_ITEMS_CAP}`),
        )
      : [];
    const itemIds = new Set(items.map((i) => i.id));
    // raw item-level relations between primary concepts: shared decisions (refs) and open conflicts
    const rel = rows<{ kind: string; rec: string; a: string; a_dom: string | null; b: string; b_dom: string | null }>(
      await tx.execute(sql`
        SELECT 'shared_decision' AS kind, p.item_id::text AS rec, p.concept_id AS a, ca.domain_id AS a_dom, r.concept_id AS b, cb.domain_id AS b_dom
        FROM concept_placements p
        JOIN concept_refs r ON r.item_kind = 'decision' AND r.item_id = p.item_id AND r.concept_id <> p.concept_id
        JOIN concepts ca ON ca.id = p.concept_id JOIN concepts cb ON cb.id = r.concept_id
        WHERE p.project_id = ${projectId} AND p.item_kind = 'decision' AND p.location = 'concept'
          AND ca.retired_at IS NULL AND cb.retired_at IS NULL
        UNION ALL
        SELECT 'conflict', c.id::text, pa.concept_id, ca.domain_id, pb.concept_id, cb.domain_id
        FROM conflicts c
        JOIN concept_placements pa ON pa.item_kind = 'decision' AND pa.item_id = c.constraint_decision_id AND pa.location = 'concept'
        JOIN concept_placements pb ON pb.item_kind = 'decision' AND pb.item_id = c.eng_decision_id AND pb.location = 'concept'
        JOIN concepts ca ON ca.id = pa.concept_id JOIN concepts cb ON cb.id = pb.concept_id
        WHERE c.project_id = ${projectId} AND c.status = 'open' AND pa.concept_id <> pb.concept_id`),
    );
    const visible = (concept: string, dom: string | null) =>
      shownIds.has(concept) ? `c:${concept}` : `d:${dom ?? UNASSIGNED}`;
    const agg = new Map<string, { from: string; to: string; kind: string; recs: Set<string> }>();
    for (const e of rel) {
      let from = visible(e.a, e.a_dom);
      let to = visible(e.b, e.b_dom);
      if (from === to) continue;
      if (e.kind === "shared_decision" && from > to) [from, to] = [to, from]; // undirected
      const k = `${from}|${to}|${e.kind}`;
      (agg.get(k) ?? agg.set(k, { from, to, kind: e.kind, recs: new Set() }).get(k)!).recs.add(e.rec);
    }
    // conflicts touching the focused concept's items, lifted to the nearest visible node
    if (focusOn) {
      const fc = rows<{
        id: string;
        a: string;
        a_concept: string | null;
        a_dom: string | null;
        b: string | null;
        b_concept: string | null;
        b_dom: string | null;
      }>(
        await tx.execute(sql`
          SELECT f.id, f.constraint_decision_id AS a, pa.concept_id AS a_concept, ca.domain_id AS a_dom,
            f.eng_decision_id AS b, pb.concept_id AS b_concept, cb.domain_id AS b_dom
          FROM conflicts f
          LEFT JOIN concept_placements pa ON pa.item_kind = 'decision' AND pa.item_id = f.constraint_decision_id
          LEFT JOIN concepts ca ON ca.id = pa.concept_id
          LEFT JOIN concept_placements pb ON pb.item_kind = 'decision' AND pb.item_id = f.eng_decision_id
          LEFT JOIN concepts cb ON cb.id = pb.concept_id
          WHERE f.project_id = ${projectId} AND f.status = 'open'
            AND (pa.concept_id = ${focusOn} OR pb.concept_id = ${focusOn})`),
      );
      const at = (d: string | null, concept: string | null, dom: string | null) =>
        d && itemIds.has(d) ? `i:${d}` : concept ? visible(concept, dom) : null;
      for (const e of fc) {
        const from = at(e.a, e.a_concept, e.a_dom);
        const to = at(e.b, e.b_concept, e.b_dom);
        if (!from || !to || from === to) continue;
        const k = `${from}|${to}|conflict`;
        (agg.get(k) ?? agg.set(k, { from, to, kind: "conflict", recs: new Set() }).get(k)!).recs.add(e.id);
      }
    }
    const edges = [...agg.values()]
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind as "shared_decision" | "conflict", weight: e.recs.size }))
      .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return {
      nodes: [
        ...ds.map((d) => ({
          id: `d:${d.id}`,
          kind: "domain" as const,
          label: d.label,
          count: d.concepts,
          ...domainSum(d.id),
          expanded: d.id === expand,
        })),
        ...((un?.n ?? 0) > 0
          ? [
              {
                id: `d:${UNASSIGNED}`,
                kind: "domain" as const,
                label: "Unassigned",
                count: un!.n,
                ...domainSum(null),
                expanded: expand === UNASSIGNED,
              },
            ]
          : []),
        ...shown.map((c) => ({
          id: `c:${c.id}`,
          kind: "concept" as const,
          label: c.label,
          key: c.key,
          count: c.items,
          decisions: byConcept.get(c.id)?.decisions ?? 0,
          conflicts: byConcept.get(c.id)?.conflicts ?? 0,
          expanded: c.id === focusOn,
          parent: `d:${expand}`,
        })),
        ...items.map((i) => ({
          id: `i:${i.id}`,
          kind: "item" as const,
          label: (i.rule_text ?? "(decision)").slice(0, 90),
          status: i.status,
          origin: i.origin,
          conflict: i.in_conflict,
          parent: `c:${focusOn}`,
        })),
      ],
      edges: edges.slice(0, GRAPH_EDGE_CAP),
      truncated: edges.length > GRAPH_EDGE_CAP,
      nextCursor: expanded.length > GRAPH_CONCEPTS_PAGE ? encodeCursor({ offset: offset + GRAPH_CONCEPTS_PAGE }) : null,
    };
  });
}
