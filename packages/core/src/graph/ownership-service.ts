import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { ownershipSnapshots, ownershipRules, ownershipRuleOwners, repos, githubInstallations } from "../db/schema.js";
import { parseCodeowners } from "./codeowners.js";
import * as gh from "../auth/github.js";

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

/**
 * Best-effort: fetch CODEOWNERS for a repo via the GitHub App installation and ingest it.
 * Returns {ingested:false} quietly if the App isn't installed, the host isn't GitHub, or
 * no CODEOWNERS exists — never throws into the caller.
 */
export async function ingestCodeownersFromGitHub(
  orgId: string,
  repoId: string,
  gitRemote: string,
): Promise<{ ingested: boolean }> {
  const parts = gitRemote.split("/");
  if (parts[0] !== "github.com" || parts.length < 3) return { ingested: false };
  const owner = parts[1]!;
  const repo = parts[2]!;

  let installationId: number;
  try {
    installationId = await gh.repoInstallationId(owner, repo);
  } catch {
    return { ingested: false };
  }

  await withOrg(orgId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(githubInstallations)
        .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)))
        .limit(1)
    )[0];
    if (!existing) await tx.insert(githubInstallations).values({ orgId, installationId, accountLogin: owner });
  });

  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const file = await gh.getFile(installationId, owner, repo, path).catch(() => null);
    if (file) {
      await refreshOwnership(orgId, repoId, file.content, file.sha);
      return { ingested: true };
    }
  }
  return { ingested: false };
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
    const owners = await tx.select().from(ownershipRuleOwners).where(eq(ownershipRuleOwners.ruleId, matchedId));
    return owners.map((o) => o.ownerLogin);
  });
}
