/**
 * Standards in the session briefing and in the copyable (repo-free) project brief (PRD §7.3).
 * Requirement text + exact versions and skill POINTERS (name, when to use) — never skill bodies.
 */
import { withOrg } from "../db/rls.js";
import { env } from "../env.js";
import { resolveForTx } from "./checks.js";

const MAX_REQS = 20;
const MAX_SKILLS = 10;

export interface SessionStandards {
  requirements: Array<{ standard: string; version: number; key: string; text: string; level: string }>;
  /** Assignments that apply only for certain paths or task types. */
  conditional: Array<{ name: string; when: string[] }>;
  skills: Array<{ slug: string; name: string; version: number; versionId: string; level: string; whenToUse: string }>;
  overflow: number;
}

/** For a repo session (code work). Null while the feature is off. */
export async function sessionStandards(c: { orgId: string; projectId: string; repoId: string; memberId: string }): Promise<SessionStandards | null> {
  if (!env.LOCKSTEP_STANDARDS) return null;
  return withOrg(c.orgId, async (tx) => {
    const { active, res } = await resolveForTx(tx, c.orgId, { projectId: c.projectId, repoId: c.repoId, paths: null, taskType: "code", memberId: c.memberId });
    const entries = new Map(active.flatMap((a) => a.items).map((i) => [i.versionId, i]));
    const reqs = res.standards.flatMap((s) =>
      s.requirements.filter((r) => !r.exempt).map((r) => ({ standard: s.name, version: s.version, key: r.key, text: r.text, level: r.level })),
    );
    reqs.sort((a, b) => Number(b.level === "required") - Number(a.level === "required"));
    const conditional = res.unknown.map((u) => {
      const a = active.find((x) => x.assignmentId === u.assignmentId);
      return { name: u.name, when: [...(a?.selectors.pathGlobs ?? []).map((g) => `touching ${g}`), ...(a?.selectors.taskTypes ?? []).filter((t) => t !== "code").map((t) => `${t} work`)] };
    });
    return {
      requirements: reqs.slice(0, MAX_REQS),
      conditional: conditional.slice(0, 10),
      skills: res.skills
        .filter((s) => !s.exempt)
        .slice(0, MAX_SKILLS)
        .map((s) => ({ slug: entries.get(s.versionId)?.slug ?? s.itemId, name: s.name, version: s.version, versionId: s.versionId, level: s.level, whenToUse: entries.get(s.versionId)?.whenToUse ?? "" })),
      overflow: Math.max(0, reqs.length - MAX_REQS),
    };
  });
}

/** Markdown section for the copyable brief (PRD work, no repository needed). */
export async function briefStandardsSection(orgId: string, projectId: string, memberId: string): Promise<string[]> {
  if (!env.LOCKSTEP_STANDARDS) return [];
  const res = await withOrg(orgId, async (tx) => (await resolveForTx(tx, orgId, { projectId, repoId: null, paths: null, taskType: "prd", memberId })).res);
  if (!res.standards.length && !res.skills.length && !res.checks.length) return [];
  const out = ["## Organization standards for this work", ""];
  for (const s of res.standards) {
    out.push(`### ${s.name} (v${s.version})`, "");
    for (const r of s.requirements)
      out.push(`- ${r.level === "required" ? "**Must**" : "Should"}: ${r.text}${r.exempt ? " _(exempt here by approved exception)_" : ""} \`${r.key}\``);
    out.push("");
  }
  if (res.skills.length)
    out.push("Skills your organization provides for this work (available in an enrolled agent workspace):", "", ...res.skills.map((s) => `- ${s.name} (v${s.version}, ${s.level})`), "");
  if (res.checks.length)
    out.push("Checks that apply — submit a saved revision in Lockstep to run them:", "", ...res.checks.map((c) => `- ${c.name} (v${c.version})`), "");
  out.push("_Copying this brief is recorded as an export. It doesn't install anything or show that the standards were followed._", "");
  return out;
}

/**
 * Map/concept pane: standards that apply to the repositories of a concept's surfaces, with the
 * selectors that matched. Derived only from assignments — never from where things sit in the Map (A5).
 */
export async function conceptStandards(orgId: string, projectId: string, conceptId: string, memberId: string) {
  if (!env.LOCKSTEP_STANDARDS) return { standards: [] };
  const { sql } = await import("drizzle-orm");
  return withOrg(orgId, async (tx) => {
    const repoIds = (
      (await tx.execute(sql`
        SELECT DISTINCT s.repo_id FROM concept_placements p JOIN surfaces s ON s.id = p.item_id
        WHERE p.item_kind = 'surface' AND p.concept_id = ${conceptId} AND s.project_id = ${projectId} AND s.removed_at IS NULL
        LIMIT 50`)) as unknown as Array<{ repo_id: string }>
    ).map((r) => r.repo_id);
    const out = new Map<string, { itemId: string; name: string; version: number; requirements: number; reasons: string[] }>();
    for (const repoId of repoIds) {
      const { res } = await resolveForTx(tx, orgId, { projectId, repoId, paths: null, taskType: "code", memberId });
      for (const s of res.standards) {
        const cur = out.get(s.versionId) ?? { itemId: s.itemId, name: s.name, version: s.version, requirements: s.requirements.length, reasons: [] };
        for (const r of s.reasons) {
          const why = `${r.name}: ${r.matched.join(", ")}`;
          if (!cur.reasons.includes(why)) cur.reasons.push(why);
        }
        out.set(s.versionId, cur);
      }
    }
    return { standards: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  });
}
