/** GitHub skill import → catalog draft, and the manual "check for upstream update" flow. */
import { and, eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { itemVersions, skillPackages, type PackageFile } from "../db/schema.js";
import { OrgError } from "./org-authority.js";
import { createItem, saveDraft } from "./catalog.js";
import { planPackage, storePackage } from "./packages.js";
import { captureSkill, parseGithubUrl, resolveCommit, type CapturedSkill } from "./github-import.js";

const declaredOf = (c: CapturedSkill) => ({
  ...c.declared,
  scripts: c.scripts,
  skipped: c.skipped,
  license: c.license,
});

/** Capture the selected skill at an exact commit and save it as a draft (nothing is published). */
export async function importGithubSkill(
  orgId: string,
  actor: string,
  input: { url: string; commit: string; ref: string; dir: string },
): Promise<{ itemId: string; versionId: string; captured: Omit<CapturedSkill, "files"> & { files: PackageFile[] } }> {
  const src = parseGithubUrl(input.url);
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new OrgError(400, "commit must be a full sha");
  const cap = await captureSkill(src, input.commit, input.ref, input.dir);
  const pkg = await storePackage(orgId, cap.files, declaredOf(cap));
  const name = typeof cap.frontmatter.name === "string" ? cap.frontmatter.name : input.dir.split("/").pop() || src.repo;
  const { itemId, versionId } = await createItem(orgId, actor, {
    kind: "skill",
    name,
    content: {
      purpose: typeof cap.frontmatter.description === "string" ? cap.frontmatter.description : "",
      whenToUse: "",
    },
    packageId: pkg.id,
  });
  await withOrg(orgId, (tx) =>
    tx.update(itemVersions).set({ provenance: cap.provenance }).where(eq(itemVersions.id, versionId)),
  );
  return { itemId, versionId, captured: { ...cap, files: planPackage(cap.files).manifest } };
}

interface Provenance {
  source?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  commit?: string;
  path?: string;
}

async function importedVersion(orgId: string, versionId: string) {
  return withOrg(orgId, async (tx) => {
    const v = (
      await tx
        .select()
        .from(itemVersions)
        .where(and(eq(itemVersions.id, versionId), eq(itemVersions.orgId, orgId)))
        .limit(1)
    )[0];
    if (!v) throw new OrgError(404, "version not found");
    const p = (v.provenance ?? {}) as Provenance;
    if (p.source !== "github" || !p.owner || !p.repo || !p.commit)
      throw new OrgError(400, "this version wasn't imported from GitHub");
    const pkg = v.packageId
      ? (await tx.select().from(skillPackages).where(eq(skillPackages.id, v.packageId)).limit(1))[0]
      : undefined;
    return { v, p, manifest: (pkg?.manifest ?? []) as PackageFile[] };
  });
}

/** Compare the captured snapshot with the upstream ref now. Read-only: no draft is created. */
export async function checkUpstream(orgId: string, versionId: string) {
  const { p, manifest } = await importedVersion(orgId, versionId);
  const src = { owner: p.owner!, repo: p.repo!, ref: p.ref ?? null, path: p.path ?? "" };
  let latest: { sha: string; ref: string };
  try {
    latest = await resolveCommit(src);
  } catch (e) {
    // a deleted/unavailable upstream never affects the captured snapshot
    return { status: "unavailable" as const, reason: (e as Error).message, currentCommit: p.commit! };
  }
  if (latest.sha === p.commit) return { status: "up_to_date" as const, currentCommit: p.commit! };
  const cap = await captureSkill(src, latest.sha, latest.ref, p.path ?? "");
  const next = planPackage(cap.files).manifest;
  const a = new Map(manifest.map((f) => [f.path, f.sha256]));
  const b = new Map(next.map((f) => [f.path, f.sha256]));
  const files = [
    ...[...b.keys()].filter((k) => !a.has(k)).map((path) => ({ path, change: "added" })),
    ...[...a.keys()].filter((k) => !b.has(k)).map((path) => ({ path, change: "removed" })),
    ...[...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).map((path) => ({ path, change: "changed" })),
  ];
  return {
    status: "update_available" as const,
    currentCommit: p.commit!,
    candidateCommit: latest.sha,
    ref: latest.ref,
    files,
  };
}

/** On request only: snapshot the candidate commit into a NEW draft of the same item. */
export async function draftFromUpstream(orgId: string, actor: string, versionId: string, candidateCommit: string) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new OrgError(400, "commit must be a full sha");
  const { v, p } = await importedVersion(orgId, versionId);
  const cap = await captureSkill(
    { owner: p.owner!, repo: p.repo!, ref: p.ref ?? null, path: p.path ?? "" },
    candidateCommit,
    p.ref ?? "",
    p.path ?? "",
  );
  const pkg = await storePackage(orgId, cap.files, declaredOf(cap));
  return saveDraft(orgId, actor, v.itemId, { content: v.content, packageId: pkg.id, provenance: cap.provenance });
}
