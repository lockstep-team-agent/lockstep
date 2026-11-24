/**
 * Audit export — "who approved this rule, and when?" One row per decision version, flattened for
 * compliance review (CSV or JSON). Read-only; scoped to one project under the caller's org RLS.
 */
import { sql } from "drizzle-orm";
import { withOrg } from "../db/rls.js";

export interface AuditRow {
  decisionId: string;
  ruleText: string;
  decisionType: string;
  status: string;
  scope: string;
  version: number;
  proposedBy: string;
  createdAt: string;
  approvals: string;
  sources: string;
  linkedPrs: string;
  supersededBy: string;
  expiresAt: string;
}

export const AUDIT_COLUMNS: Array<[keyof AuditRow, string]> = [
  ["decisionId", "decision_id"],
  ["ruleText", "rule_text"],
  ["decisionType", "decision_type"],
  ["status", "status"],
  ["scope", "scope"],
  ["version", "version"],
  ["proposedBy", "proposed_by"],
  ["createdAt", "created_at"],
  ["approvals", "approvals"],
  ["sources", "sources"],
  ["linkedPrs", "linked_prs"],
  ["supersededBy", "superseded_by"],
  ["expiresAt", "expires_at"],
];

const iso = (col: ReturnType<typeof sql.raw>) => sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function auditExport(orgId: string, projectId: string): Promise<{ projectName: string; rows: AuditRow[] }> {
  return withOrg(orgId, async (tx) => {
    const proj = (await tx.execute(sql`SELECT name FROM projects WHERE id = ${projectId}`)) as unknown as Array<{
      name: string;
    }>;
    // Approvals are per version; provenance sources are per decision. Linked PRs: merged-PR contract
    // rows (delta.kind = pr-merge, written by the GitHub webhook) on a surface-scoped decision's surface.
    const rows = (await tx.execute(sql`
      SELECT
        d.id AS "decisionId",
        v.rule_text AS "ruleText",
        d.decision_type AS "decisionType",
        v.status AS "status",
        d.scope_kind || ':' || d.scope_ref AS "scope",
        v.version AS "version",
        COALESCE(pm.github_login, '') AS "proposedBy",
        ${iso(sql.raw("v.created_at"))} AS "createdAt",
        COALESCE((
          SELECT string_agg(COALESCE(m.github_login, '?') || ' ' || a.verdict || ' ' || ${iso(sql.raw("a.created_at"))}, '; ' ORDER BY a.created_at)
          FROM decision_approvals a LEFT JOIN members m ON m.id = a.reviewer_id
          WHERE a.decision_id = d.id AND a.version = v.version
        ), '') AS "approvals",
        COALESCE((
          SELECT string_agg(p.source || COALESCE(' ' || p.url, ''), '; ' ORDER BY p.created_at)
          FROM decision_provenances p WHERE p.decision_id = d.id
        ), '') AS "sources",
        COALESCE((
          SELECT string_agg(DISTINCT '#' || (c.delta->>'prNumber'), '; ')
          FROM contracts c JOIN repos r ON r.id = c.repo_id
          WHERE d.scope_kind = 'surface' AND r.project_id = d.project_id AND c.surface = d.scope_ref
            AND c.delta->>'kind' = 'pr-merge' AND c.delta->>'prNumber' IS NOT NULL
        ), '') AS "linkedPrs",
        COALESCE(d.superseded_by_id::text, '') AS "supersededBy",
        COALESCE(${iso(sql.raw("d.expires_at"))}, '') AS "expiresAt"
      FROM decisions d
      JOIN decision_versions v ON v.decision_id = d.id
      LEFT JOIN members pm ON pm.id = v.proposed_by
      WHERE d.project_id = ${projectId}
      ORDER BY d.created_at, d.id, v.version
    `)) as unknown as AuditRow[];
    return { projectName: proj[0]?.name ?? "project", rows: rows.map((r) => ({ ...r, version: Number(r.version) })) };
  });
}

/**
 * RFC 4180: quote every field that contains a comma, quote, CR or LF; double embedded quotes.
 * Agent-written text leading with = + - @ is prefixed with ' so spreadsheets don't run it as a formula.
 */
export function csvField(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: AuditRow[]): string {
  const lines = [AUDIT_COLUMNS.map(([, h]) => h).join(",")];
  for (const r of rows) lines.push(AUDIT_COLUMNS.map(([k]) => csvField(r[k])).join(","));
  return lines.join("\r\n") + "\r\n";
}
