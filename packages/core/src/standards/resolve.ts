/**
 * Applicability resolution — pure and deterministic. Given one work context and the org's active
 * assignments, decide which standards, skills and checks apply and why.
 *
 * Rules (PRD §6.4–6.5):
 *  - within one selector, values are OR; across selector dimensions, AND; an empty selector = any.
 *  - assignments are cumulative (a narrower one never cancels an org baseline).
 *  - the same skill at the same version from several assignments is delivered once, with every
 *    reason; at different versions (any kind) it is BLOCKED — never last-write-wins.
 *  - unknown context (no task type / no file paths) is reported, never treated as a match.
 *  - approved, unexpired exceptions bound to the EXACT published version (PRD §7.6) and matching
 *    scope mark items exempt; a new version always needs its own review.
 */
import { createHash } from "node:crypto";
import type { Selectors } from "../db/schema.js";

/** What an exception binds to: a requirement's text + level (so wording changes need review). */
export const requirementHash = (r: { text: string; level: string }): string =>
  createHash("sha256").update(`${r.text}\n${r.level}`).digest("hex");

export interface WorkContext {
  projectId: string | null;
  repoId: string | null;
  /** Files in scope; null = unknown (e.g. a session that hasn't touched files yet). */
  paths: string[] | null;
  taskType: "code" | "prd" | null;
  memberId: string;
  teamIds: string[];
}

export interface ReleaseEntry {
  itemId: string;
  versionId: string;
  kind: "standard" | "skill" | "check";
  name: string;
  version: number;
  slug?: string;
  /** Skills only: the content-addressed package to install. */
  packageId?: string | null;
  packageHash?: string | null;
  /** Skills only: when the agent should reach for it (briefing pointer). */
  whenToUse?: string;
  /** Checks only: the check definition. */
  check?: { artifactType: string; method: string; requirementKeys: string[]; requiredSections: string[]; instructions: string };
  /** Standards only: the task types the author declared (a standard never applies outside them). */
  taskTypes?: string[];
  /** Standards only: check versions the standard pins. */
  pinnedChecks?: string[];
  /** Standards only: requirements to apply. */
  requirements?: Array<{ key: string; text: string; level: string }>;
}

export interface ActiveAssignment {
  assignmentId: string;
  name: string;
  revision: number;
  level: "required" | "recommended";
  selectors: Selectors;
  pilot: Selectors | null;
  releaseId?: string;
  items: ReleaseEntry[];
}

export interface ExceptionRow {
  id: string;
  target: "requirement" | "skill_assignment";
  itemId: string;
  versionId: string;
  requirementKey: string | null;
  scope: { projectId?: string; repoId?: string; taskType?: string; memberId?: string };
  expiresAt: Date | null;
  /** Bound content (requirementHash / package hash); null = legacy exact-version binding. */
  contentHash?: string | null;
}

export interface Reason {
  assignmentId: string;
  name: string;
  revision: number;
  matched: string[];
}

export interface Resolution {
  standards: Array<{
    itemId: string;
    versionId: string;
    name: string;
    version: number;
    reasons: Reason[];
    requirements: Array<{ key: string; text: string; level: string; exempt: boolean; exceptionId: string | null }>;
  }>;
  skills: Array<{
    itemId: string;
    versionId: string;
    name: string;
    version: number;
    level: "required" | "recommended";
    reasons: Reason[];
    exempt: boolean;
    exceptionId: string | null;
  }>;
  checks: Array<{ itemId: string; versionId: string; name: string; version: number; reasons: Reason[] }>;
  blocked: Array<{
    itemId: string;
    name: string;
    versions: Array<{ versionId: string; version: number; reasons: Reason[] }>;
  }>;
  /** Assignments that MIGHT apply once the missing context is known. */
  unknown: Array<{ assignmentId: string; name: string; missing: string[] }>;
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

type Match = { ok: true; matched: string[] } | { ok: false; missing: string[] | null };

/** Does a selector set match the context? `missing` = it would depend on unknown context. */
export function matchSelectors(s: Selectors, ctx: WorkContext): Match {
  const matched: string[] = [];
  const missing: string[] = [];
  if (s.projects?.length) {
    if (!ctx.projectId || !s.projects.includes(ctx.projectId)) return { ok: false, missing: null };
    matched.push("project");
  }
  if (s.repos?.length) {
    if (!ctx.repoId || !s.repos.includes(ctx.repoId)) return { ok: false, missing: null };
    matched.push("repository");
  }
  const audience = s.audience ?? { kind: "all" as const };
  if (audience.kind === "members") {
    if (!audience.ids.includes(ctx.memberId)) return { ok: false, missing: null };
    matched.push("member");
  } else if (audience.kind === "teams") {
    if (!audience.ids.some((t) => ctx.teamIds.includes(t))) return { ok: false, missing: null };
    matched.push("team");
  }
  if (s.taskTypes?.length) {
    if (ctx.taskType === null) missing.push("task type");
    else if (!s.taskTypes.includes(ctx.taskType)) return { ok: false, missing: null };
    else matched.push("task type");
  }
  if (s.pathGlobs?.length) {
    if (ctx.paths === null) missing.push("file paths");
    else {
      const res = s.pathGlobs.map(globToRegExp);
      if (!ctx.paths.some((p) => res.some((r) => r.test(p)))) return { ok: false, missing: null };
      matched.push("file pattern");
    }
  }
  if (missing.length) return { ok: false, missing };
  if (matched.length === 0 || (!s.projects?.length && !s.repos?.length)) matched.unshift("organization baseline");
  return { ok: true, matched };
}

function exceptionFor(
  ex: ExceptionRow[],
  ctx: WorkContext,
  now: Date,
  pred: (e: ExceptionRow) => boolean,
): ExceptionRow | null {
  return (
    ex.find(
      (e) =>
        pred(e) &&
        (!e.expiresAt || e.expiresAt > now) &&
        (!e.scope.projectId || e.scope.projectId === ctx.projectId) &&
        (!e.scope.repoId || e.scope.repoId === ctx.repoId) &&
        (!e.scope.taskType || e.scope.taskType === ctx.taskType) &&
        (!e.scope.memberId || e.scope.memberId === ctx.memberId),
    ) ?? null
  );
}

export function resolveApplicability(
  ctx: WorkContext,
  assignments: ActiveAssignment[],
  approvedExceptions: ExceptionRow[],
  now = new Date(),
): Resolution {
  const out: Resolution = { standards: [], skills: [], checks: [], blocked: [], unknown: [] };
  // itemId → versionId → { entry, reasons, level }
  const byItem = new Map<
    string,
    Map<string, { e: ReleaseEntry; reasons: Reason[]; level: "required" | "recommended" }>
  >();

  for (const a of [...assignments].sort((x, y) => (x.assignmentId < y.assignmentId ? -1 : 1))) {
    let m = matchSelectors(a.selectors, ctx);
    if (m.ok && a.pilot) {
      const p = matchSelectors(a.pilot, ctx);
      m = p.ok ? { ok: true, matched: [...m.matched, "pilot"] } : p;
    }
    if (!m.ok) {
      if (m.missing) out.unknown.push({ assignmentId: a.assignmentId, name: a.name, missing: m.missing });
      continue;
    }
    const reason: Reason = { assignmentId: a.assignmentId, name: a.name, revision: a.revision, matched: m.matched };
    for (const e of a.items) {
      // Authored task types narrow the assignment's scope; they never widen it (review #16).
      if (e.kind === "standard" && ctx.taskType && e.taskTypes?.length && !e.taskTypes.includes(ctx.taskType)) continue;
      const versions = byItem.get(e.itemId) ?? byItem.set(e.itemId, new Map()).get(e.itemId)!;
      const cur = versions.get(e.versionId);
      if (cur) {
        cur.reasons.push(reason);
        if (a.level === "required") cur.level = "required"; // required wins over recommended
      } else versions.set(e.versionId, { e, reasons: [reason], level: a.level });
    }
  }

  for (const [itemId, versions] of [...byItem.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const vs = [...versions.values()].sort((a, b) => a.e.version - b.e.version);
    const first = vs[0]!;
    if (vs.length > 1) {
      // two versions of one item in one context is ambiguous for any kind — surface it, never pick
      out.blocked.push({
        itemId,
        name: first.e.name,
        versions: vs.map((v) => ({ versionId: v.e.versionId, version: v.e.version, reasons: v.reasons })),
      });
      continue;
    }
    for (const v of vs) {
      const e = v.e;
      if (e.kind === "skill") {
        const x = exceptionFor(
          approvedExceptions,
          ctx,
          now,
          (x) => x.target === "skill_assignment" && x.itemId === itemId && x.versionId === e.versionId,
        );
        out.skills.push({
          itemId,
          versionId: e.versionId,
          name: e.name,
          version: e.version,
          level: v.level,
          reasons: v.reasons,
          exempt: Boolean(x),
          exceptionId: x?.id ?? null,
        });
      } else if (e.kind === "standard") {
        out.standards.push({
          itemId,
          versionId: e.versionId,
          name: e.name,
          version: e.version,
          reasons: v.reasons,
          requirements: (e.requirements ?? []).map((r) => {
            const x = exceptionFor(
              approvedExceptions,
              ctx,
              now,
              (x) => x.target === "requirement" && x.versionId === e.versionId && x.requirementKey === r.key,
            );
            return { ...r, exempt: Boolean(x), exceptionId: x?.id ?? null };
          }),
        });
      } else out.checks.push({ itemId, versionId: e.versionId, name: e.name, version: e.version, reasons: v.reasons });
    }
  }
  const byName = <T extends { name: string; itemId: string }>(a: T, b: T) =>
    a.name.localeCompare(b.name) || (a.itemId < b.itemId ? -1 : 1);
  out.standards.sort(byName);
  out.skills.sort(byName);
  out.checks.sort(byName);
  out.blocked.sort(byName);
  return out;
}
