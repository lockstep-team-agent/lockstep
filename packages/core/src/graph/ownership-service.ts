import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { ownershipSnapshots, ownershipRules, ownershipRuleOwners, repos } from "../db/schema.js";
import { parseCodeowners } from "./codeowners.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

/**
 * Build a new immutable ownership snapshot for a repo from CODEOWNERS content.
 * Old snapshots stay (append-only audit); only `is_current` flips.
 */
export async function refreshOwnership(
  orgId: string,
  repoId: string,
  content: string,
  sha: string,
): Promise<{ snapshotId: string; ruleCount: number }> {
  const rules = parseCodeowners(content);
  return withOrg(orgId, async (tx) => {
    await tx
      .update(ownershipSnapshots)
      .set({ isCurrent: false })
      .where(and(eq(ownershipSnapshots.repoId, repoId), eq(ownershipSnapshots.isCurrent, true)));

    const snap = one(
      await tx
        .insert(ownershipSnapshots)
        .values({ orgId, repoId, codeownersSha: sha, builtFrom: "codeowners", isCurrent: true })
        .returning(),
    );

    for (const r of rules) {
      const rule = one(
        await tx
          .insert(ownershipRules)
          .values({
            orgId,
            repoId,
            snapshotId: snap.id,
            pattern: r.pattern,
            patternRegex: r.regex,
            precedence: r.precedence,
            source: "codeowners",
          })
          .returning(),
      );
      for (const owner of r.owners) {
        await tx.insert(ownershipRuleOwners).values({ orgId, ruleId: rule.id, ownerLogin: owner });
      }
    }

    await tx.update(repos).set({ codeownersSha: sha }).where(eq(repos.id, repoId));
    return { snapshotId: snap.id, ruleCount: rules.length };
  });
}

/** Resolve owners of a repo-relative path from the current snapshot (last match wins). */
export async function whoowns(orgId: string, repoId: string, path: string): Promise<string[]> {
  return withOrg(orgId, async (tx) => {
    const snap = (
      await tx
        .select()
        .from(ownershipSnapshots)
        .where(and(eq(ownershipSnapshots.repoId, repoId), eq(ownershipSnapshots.isCurrent, true)))
        .limit(1)
    )[0];
    if (!snap) return [];
    const rules = await tx
      .select()
      .from(ownershipRules)
      .where(eq(ownershipRules.snapshotId, snap.id))
      .orderBy(asc(ownershipRules.precedence));

    let matchedId: string | null = null;
    for (const r of rules) {
      if (new RegExp(r.patternRegex).test(path)) matchedId = r.id;
    }
    if (!matchedId) return [];
    const owners = await tx
      .select()
      .from(ownershipRuleOwners)
      .where(eq(ownershipRuleOwners.ruleId, matchedId));
    return owners.map((o) => o.ownerLogin);
  });
}
