/**
 * Standards & Skills catalog: items with draft → (proposed) → published versions. Published
 * versions are immutable (DB trigger); editing one opens a new draft. Publishing never touches an
 * assignment or installs anything. Members draft and propose; owners/admins publish and archive.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "../db/rls.js";
import { catalogItems, itemVersions, skillPackages, type PackageFile } from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { sha256Hex, blobStore } from "../storage/blob.js";
import { getOrgRoleTx, OrgError } from "./org-authority.js";
import { parseFrontmatter } from "./packages.js";

export type Kind = "standard" | "skill" | "check";
export const TASK_TYPES = ["code", "prd"] as const;

const requirement = z.object({
  key: z
    .string()
    .regex(/^req_[a-z0-9]{8,}$/)
    .optional(),
  text: z.string().trim().min(1).max(2000),
  rationale: z.string().max(4000).optional().default(""),
  level: z.enum(["required", "recommended"]),
});
const pin = z.object({ itemId: z.string().uuid(), versionId: z.string().uuid() });

export const standardContent = z.object({
  purpose: z.string().max(4000).default(""),
  taskTypes: z.array(z.enum(TASK_TYPES)).default([]),
  requirements: z.array(requirement).max(200).default([]),
  examples: z.string().max(20000).optional().default(""),
  sourceLinks: z.array(z.string().url()).max(50).default([]),
  skills: z.array(pin).max(50).default([]),
  checks: z.array(pin).max(50).default([]),
  decisionIds: z.array(z.string().uuid()).max(100).default([]),
});
export const skillContent = z.object({
  purpose: z.string().max(4000).default(""),
  whenToUse: z.string().max(4000).default(""),
});
export const checkContent = z.object({
  artifactType: z.enum(["code_diff", "prd"]),
  method: z.enum(["structural", "rubric"]),
  requirementKeys: z.array(z.string()).max(200).default([]),
  instructions: z.string().max(20000).default(""),
  expectedEvidence: z.string().max(4000).default(""),
  requiredSections: z.array(z.string().max(200)).max(100).default([]),
});
const SCHEMA = { standard: standardContent, skill: skillContent, check: checkContent } as const;

export type StandardContent = z.infer<typeof standardContent>;

const newKey = () => `req_${randomBytes(6).toString("hex")}`;
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "item";
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

/** Parse content for a kind; stable requirement keys are assigned to new requirements. */
export function normalizeContent(kind: Kind, raw: unknown): Record<string, unknown> {
  const parsed = SCHEMA[kind].safeParse(raw ?? {});
  if (!parsed.success) throw new OrgError(400, `invalid ${kind}: ${parsed.error.issues[0]?.message ?? "content"}`);
  if (kind === "standard") {
    const c = parsed.data as StandardContent;
    const keys = new Set<string>();
    c.requirements = c.requirements.map((r) => {
      const key = r.key ?? newKey();
      if (keys.has(key)) throw new OrgError(400, `duplicate requirement key ${key}`);
      keys.add(key);
      return { ...r, key };
    });
    return c as unknown as Record<string, unknown>;
  }
  return parsed.data as Record<string, unknown>;
}

async function roleTx(tx: Tx, orgId: string, actor: string) {
  return getOrgRoleTx(tx, orgId, actor);
}
async function requireAdminTx(tx: Tx, orgId: string, actor: string) {
  const r = await roleTx(tx, orgId, actor);
  if (r !== "owner" && r !== "admin") throw new OrgError(403, "requires org owner or admin");
}

async function itemTx(tx: Tx, orgId: string, itemId: string) {
  const it = (
    await tx
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.id, itemId), eq(catalogItems.orgId, orgId)))
      .limit(1)
  )[0];
  if (!it) throw new OrgError(404, "catalog item not found");
  return it;
}

export async function createItem(
  orgId: string,
  actor: string,
  input: { kind: Kind; name: string; content?: unknown; packageId?: string | null },
): Promise<{ itemId: string; versionId: string }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new OrgError(400, "name required");
  const content = normalizeContent(
    input.kind,
    input.content ?? (input.kind === "check" ? { artifactType: "prd", method: "structural" } : {}),
  );
  return withOrg(orgId, async (tx) => {
    let slug = slugify(name);
    const clash = (
      await tx
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(and(eq(catalogItems.orgId, orgId), eq(catalogItems.kind, input.kind), eq(catalogItems.slug, slug)))
        .limit(1)
    )[0];
    if (clash) slug = `${slug}-${randomBytes(2).toString("hex")}`;
    const [it] = await tx
      .insert(catalogItems)
      .values({ orgId, kind: input.kind, slug, name, ownerMemberId: actor })
      .returning();
    const [v] = await tx
      .insert(itemVersions)
      .values({
        orgId,
        itemId: it!.id,
        version: 1,
        content,
        contentHash: sha256Hex(canonical(content)),
        packageId: input.packageId ?? null,
        authoredBy: actor,
      })
      .returning();
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "catalog.item_created",
      entityKind: "catalog_item",
      entityId: it!.id,
      payload: { kind: input.kind, name },
    });
    return { itemId: it!.id, versionId: v!.id };
  });
}

/**
 * Save the working draft. When the latest version is published, a new draft version is opened
 * (parent = the published one), so published content never changes.
 */
export async function saveDraft(
  orgId: string,
  actor: string,
  itemId: string,
  input: {
    content: unknown;
    packageId?: string | null;
    provenance?: unknown;
    /**
     * The version the editor was showing (id + review hash). When given, the save is refused if the
     * latest version has moved on — so an editor can never save, and then publish, content or a
     * package its user didn't see.
     */
    expected?: { versionId: string; reviewHash: string };
  },
): Promise<{ versionId: string; version: number; reviewHash: string }> {
  return withOrg(orgId, async (tx) => {
    const it = await itemTx(tx, orgId, itemId);
    if (it.archivedAt) throw new OrgError(409, "archived items can't be edited");
    const content = normalizeContent(it.kind as Kind, input.content);
    const latest = (
      await tx
        .select()
        .from(itemVersions)
        .where(eq(itemVersions.itemId, itemId))
        .orderBy(desc(itemVersions.version))
        .limit(1)
        .for("update")
    )[0]!;
    if (input.expected && (latest.id !== input.expected.versionId || reviewHashOf(latest) !== input.expected.reviewHash))
      throw new OrgError(409, "this item changed since you opened it — reload to review the current version");
    const role = await roleTx(tx, orgId, actor);
    const patch = {
      content,
      contentHash: sha256Hex(canonical(content)),
      ...(input.packageId !== undefined ? { packageId: input.packageId } : {}),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    };
    if (latest.state !== "published") {
      if (latest.authoredBy !== actor && role !== "owner" && role !== "admin") {
        throw new OrgError(403, "only the draft's author or an org admin can edit it");
      }
      const [u] = await tx
        .update(itemVersions)
        .set({ ...patch, state: "draft", proposedBy: null, updatedAt: new Date() })
        .where(eq(itemVersions.id, latest.id))
        .returning();
      return { versionId: u!.id, version: u!.version, reviewHash: reviewHashOf(u!) };
    }
    const [v] = await tx
      .insert(itemVersions)
      .values({
        orgId,
        itemId,
        version: latest.version + 1,
        packageId: latest.packageId,
        provenance: latest.provenance,
        parentVersionId: latest.id,
        authoredBy: actor,
        ...patch,
      })
      .returning();
    return { versionId: v!.id, version: v!.version, reviewHash: reviewHashOf(v!) };
  });
}

/** Members propose; the proposal waits for an owner/admin to publish. */
export async function proposeVersion(orgId: string, actor: string, versionId: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const v = (
      await tx
        .select()
        .from(itemVersions)
        .where(and(eq(itemVersions.id, versionId), eq(itemVersions.orgId, orgId)))
        .limit(1)
    )[0];
    if (!v) throw new OrgError(404, "version not found");
    if (v.state === "published") throw new OrgError(409, "already published");
    await tx
      .update(itemVersions)
      .set({ state: "proposed", proposedBy: actor, updatedAt: new Date() })
      .where(eq(itemVersions.id, versionId));
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "catalog.version_proposed",
      entityKind: "catalog_item",
      entityId: v.itemId,
      entityVersion: v.version,
      payload: {},
    });
  });
}

/** What would block publication, in plain words (empty = publishable). */
export async function publishBlockersTx(
  tx: Tx,
  orgId: string,
  kind: Kind,
  content: Record<string, unknown>,
  packageId: string | null,
): Promise<string[]> {
  const out: string[] = [];
  if (kind === "standard") {
    const c = content as StandardContent;
    if (c.requirements.length === 0) out.push("A standard needs at least one requirement.");
    if (c.taskTypes.length === 0) out.push("Choose at least one task type (code changes or PRD work).");
    const pins = [...c.skills, ...c.checks];
    if (pins.length) {
      const found = await tx
        .select({ id: itemVersions.id, state: itemVersions.state, itemId: itemVersions.itemId })
        .from(itemVersions)
        .where(
          and(
            eq(itemVersions.orgId, orgId),
            inArray(
              itemVersions.id,
              pins.map((p) => p.versionId),
            ),
          ),
        );
      for (const p of pins) {
        const f = found.find((x) => x.id === p.versionId);
        if (!f || f.itemId !== p.itemId) out.push(`Linked version ${p.versionId.slice(0, 8)} doesn't exist.`);
        else if (f.state !== "published") out.push(`Linked version ${p.versionId.slice(0, 8)} isn't published yet.`);
      }
    }
  } else if (kind === "skill") {
    if (!packageId) out.push("A skill needs its package (at least SKILL.md).");
    else {
      const p = (
        await tx
          .select()
          .from(skillPackages)
          .where(and(eq(skillPackages.id, packageId), eq(skillPackages.orgId, orgId)))
          .limit(1)
      )[0];
      if (!p) out.push("The skill's package is missing.");
    }
  } else if (kind === "check") {
    const c = content as { artifactType: string; method: string; requiredSections: string[]; instructions: string };
    // Only combinations Lockstep can actually evaluate are publishable (review #8).
    if (c.artifactType === "code_diff" && c.method !== "rubric")
      out.push("Code-diff checks support the rubric method only (structural checks are for PRDs).");
    if (c.method === "structural" && ((content as { requirementKeys?: string[] }).requirementKeys?.length ?? 0) > 1)
      out.push("A section check can link at most one requirement (its findings are attributed to it).");
    if (c.method === "structural" && c.requiredSections.length === 0)
      out.push("A structural check needs at least one required section.");
    if (c.method === "rubric" && !c.instructions.trim()) out.push("A rubric check needs evaluation instructions.");
  }
  return out;
}

/** What an approver reviewed: the draft's content and exact package. Publish must present it. */
export const reviewHashOf = (v: { contentHash: string; packageId: string | null }) =>
  sha256Hex(`${v.contentHash}:${v.packageId ?? ""}`);

/**
 * Publish exactly the content that was reviewed. The row is locked for the whole check, and
 * `expectedHash` (from the preview the approver saw) must still match — an edit in between is a
 * conflict that requires a fresh review, never a silent approval of different content.
 */
export async function publishVersion(orgId: string, actor: string, versionId: string, expectedHash?: string): Promise<{ version: number }> {
  return withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    const v = (
      await tx
        .select()
        .from(itemVersions)
        .where(and(eq(itemVersions.id, versionId), eq(itemVersions.orgId, orgId)))
        .limit(1)
        .for("update")
    )[0];
    if (!v) throw new OrgError(404, "version not found");
    if (v.state === "published") throw new OrgError(409, "already published");
    if (expectedHash !== undefined && expectedHash !== reviewHashOf(v))
      throw new OrgError(409, "this draft changed after you reviewed it — review the current version before publishing");
    const it = await itemTx(tx, orgId, v.itemId);
    if (it.archivedAt) throw new OrgError(409, "archived items can't be published");
    const blockers = await publishBlockersTx(
      tx,
      orgId,
      it.kind as Kind,
      v.content as Record<string, unknown>,
      v.packageId,
    );
    if (blockers.length) throw new OrgError(409, blockers.join(" "));
    await tx
      .update(itemVersions)
      .set({ state: "published", publishedAt: new Date(), approvedBy: actor, updatedAt: new Date() })
      .where(eq(itemVersions.id, versionId));
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "catalog.version_published",
      entityKind: "catalog_item",
      entityId: it.id,
      entityVersion: v.version,
      payload: { kind: it.kind },
    });
    return { version: v.version };
  });
}

/** Hide from new selection. Assigned versions keep working until a rollout changes them. */
export async function setArchived(orgId: string, actor: string, itemId: string, archived: boolean): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    await itemTx(tx, orgId, itemId);
    await tx
      .update(catalogItems)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(catalogItems.id, itemId));
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: archived ? "catalog.item_archived" : "catalog.item_restored",
      entityKind: "catalog_item",
      entityId: itemId,
      payload: {},
    });
  });
}

export async function listCatalog(orgId: string, opts: { kind?: Kind; archived?: boolean } = {}) {
  return withOrg(orgId, async (tx) => {
    const items = await tx
      .select()
      .from(catalogItems)
      .where(
        and(
          eq(catalogItems.orgId, orgId),
          opts.kind ? eq(catalogItems.kind, opts.kind) : undefined,
          opts.archived ? undefined : isNull(catalogItems.archivedAt),
        ),
      )
      .orderBy(catalogItems.name);
    if (items.length === 0) return [];
    const vs = await tx
      .select({
        id: itemVersions.id,
        itemId: itemVersions.itemId,
        version: itemVersions.version,
        state: itemVersions.state,
        publishedAt: itemVersions.publishedAt,
        updatedAt: itemVersions.updatedAt,
      })
      .from(itemVersions)
      .where(
        inArray(
          itemVersions.itemId,
          items.map((i) => i.id),
        ),
      )
      .orderBy(desc(itemVersions.version));
    return items.map((i) => {
      const mine = vs.filter((v) => v.itemId === i.id);
      const published = mine.find((v) => v.state === "published") ?? null;
      const working = mine[0] && mine[0].state !== "published" ? mine[0] : null;
      return {
        id: i.id,
        kind: i.kind,
        slug: i.slug,
        name: i.name,
        archived: Boolean(i.archivedAt),
        published,
        working,
      };
    });
  });
}

export async function getItem(orgId: string, itemId: string) {
  return withOrg(orgId, async (tx) => {
    const it = await itemTx(tx, orgId, itemId);
    const versions = await tx
      .select()
      .from(itemVersions)
      .where(eq(itemVersions.itemId, itemId))
      .orderBy(desc(itemVersions.version));
    return { item: it, versions };
  });
}

type Req = { key: string; text: string; rationale: string; level: string };

/** Field-visible diff: requirements by stable key, other fields by value, packages by file. */
export async function diffVersions(orgId: string, fromId: string, toId: string) {
  const d = await withOrg(orgId, async (tx) => {
    const [a, b] = await Promise.all(
      [fromId, toId].map(async (id) => {
        const v = (
          await tx
            .select()
            .from(itemVersions)
            .where(and(eq(itemVersions.id, id), eq(itemVersions.orgId, orgId)))
            .limit(1)
        )[0];
        if (!v) throw new OrgError(404, "version not found");
        return v;
      }),
    );
    if (a!.itemId !== b!.itemId) throw new OrgError(400, "versions belong to different items");
    const ca = a!.content as Record<string, unknown>;
    const cb = b!.content as Record<string, unknown>;
    const fields = [...new Set([...Object.keys(ca), ...Object.keys(cb)])]
      .filter((k) => k !== "requirements" && canonical(ca[k]) !== canonical(cb[k]))
      .map((k) => ({ field: k, from: ca[k] ?? null, to: cb[k] ?? null }));
    const ra = new Map(((ca.requirements as Req[] | undefined) ?? []).map((r) => [r.key, r]));
    const rb = new Map(((cb.requirements as Req[] | undefined) ?? []).map((r) => [r.key, r]));
    const requirements = [
      ...[...rb.values()].filter((r) => !ra.has(r.key)).map((r) => ({ key: r.key, change: "added" as const, to: r })),
      ...[...ra.values()]
        .filter((r) => !rb.has(r.key))
        .map((r) => ({ key: r.key, change: "removed" as const, from: r })),
      ...[...rb.values()]
        .filter((r) => ra.has(r.key) && canonical(ra.get(r.key)) !== canonical(r))
        .map((r) => ({ key: r.key, change: "changed" as const, from: ra.get(r.key)!, to: r })),
    ];
    const pkg = async (id: string | null) =>
      id ? ((await tx.select().from(skillPackages).where(eq(skillPackages.id, id)).limit(1))[0]?.manifest ?? []) : [];
    const [ma, mb] = await Promise.all([pkg(a!.packageId), pkg(b!.packageId)]);
    const fa = new Map((ma as PackageFile[]).map((f) => [f.path, f]));
    const fb = new Map((mb as PackageFile[]).map((f) => [f.path, f]));
    const files: Array<{ path: string; change: string; from?: string; to?: string; diff?: DiffLine[] | null }> = [
      ...[...fb.keys()].filter((p) => !fa.has(p)).map((path) => ({ path, change: "added", to: fb.get(path)!.sha256 })),
      ...[...fa.keys()].filter((p) => !fb.has(p)).map((path) => ({ path, change: "removed", from: fa.get(path)!.sha256 })),
      ...[...fb.keys()]
        .filter((p) => fa.has(p) && fa.get(p)!.sha256 !== fb.get(p)!.sha256)
        .map((path) => ({ path, change: "changed", from: fa.get(path)!.sha256, to: fb.get(path)!.sha256 })),
    ];
    return {
      from: { id: a!.id, version: a!.version },
      to: { id: b!.id, version: b!.version },
      fields,
      requirements,
      files,
    };
  });
  // Text files get a line diff so a reviewer can read what changed (binary/huge: null).
  const text = async (sha?: string) => {
    if (!sha) return "";
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await blobStore().get(orgId, sha));
    } catch {
      return null;
    }
  };
  for (const f of d.files) {
    const [a, b] = await Promise.all([text(f.from), text(f.to)]);
    f.diff = a === null || b === null ? null : lineDiff(a, b);
    delete f.from;
    delete f.to;
  }
  return d;
}

export type DiffLine = { op: " " | "+" | "-"; line: string };

/** Minimal LCS line diff; null when too large to diff usefully in a review panel. */
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  if (x.length * y.length > 4_000_000) return null;
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ op: " ", line: x[i]! }), i++, j++);
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: "-", line: x[i++]! });
    else out.push({ op: "+", line: y[j++]! });
  }
  while (i < n) out.push({ op: "-", line: x[i++]! });
  while (j < m) out.push({ op: "+", line: y[j++]! });
  return out;
}

/** Exactly what an employee receives from this version, plus anything unresolved. */
export async function previewVersion(orgId: string, versionId: string) {
  const data = await withOrg(orgId, async (tx) => {
    const v = (
      await tx
        .select()
        .from(itemVersions)
        .where(and(eq(itemVersions.id, versionId), eq(itemVersions.orgId, orgId)))
        .limit(1)
    )[0];
    if (!v) throw new OrgError(404, "version not found");
    const it = await itemTx(tx, orgId, v.itemId);
    const content = v.content as Record<string, unknown>;
    const blockers = await publishBlockersTx(tx, orgId, it.kind as Kind, content, v.packageId);
    let linked: Array<{
      itemId: string;
      versionId: string;
      name: string;
      kind: string;
      version: number;
      state: string;
    }> = [];
    if (it.kind === "standard") {
      const pins = [
        ...(content.skills as Array<{ itemId: string; versionId: string }>),
        ...(content.checks as Array<{ itemId: string; versionId: string }>),
      ];
      if (pins.length) {
        linked = (
          await tx
            .select({
              itemId: itemVersions.itemId,
              versionId: itemVersions.id,
              name: catalogItems.name,
              kind: catalogItems.kind,
              version: itemVersions.version,
              state: itemVersions.state,
            })
            .from(itemVersions)
            .innerJoin(catalogItems, eq(catalogItems.id, itemVersions.itemId))
            .where(
              inArray(
                itemVersions.id,
                pins.map((p) => p.versionId),
              ),
            )
        ).map((x) => x);
      }
    }
    const pkg = v.packageId
      ? ((await tx.select().from(skillPackages).where(eq(skillPackages.id, v.packageId)).limit(1))[0] ?? null)
      : null;
    return { v, it, content, blockers, linked, pkg };
  });
  let skillMd: string | null = null;
  let frontmatter: Record<string, string | string[]> = {};
  // Every file, readable before publishing: text shown in full, binaries flagged, never executed.
  const fileTexts: Array<{ path: string; text: string | null; binary: boolean; unavailable?: boolean }> = [];
  if (data.pkg) {
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (const f of data.pkg.manifest) {
      try {
        const bytes = await blobStore().get(orgId, f.sha256);
        let text: string | null = null;
        try {
          text = dec.decode(bytes);
        } catch {
          text = null;
        }
        fileTexts.push({ path: f.path, text, binary: text === null });
        if (f.path === "SKILL.md" && text !== null) {
          skillMd = text;
          frontmatter = parseFrontmatter(text).data;
        }
      } catch {
        fileTexts.push({ path: f.path, text: null, binary: false, unavailable: true }); // storage down: manifest still shown
      }
    }
  }
  return {
    item: { id: data.it.id, kind: data.it.kind, name: data.it.name, slug: data.it.slug },
    version: { id: data.v.id, version: data.v.version, state: data.v.state, provenance: data.v.provenance, reviewHash: reviewHashOf(data.v) },
    fileTexts,
    content: data.content,
    brief:
      data.it.kind === "standard"
        ? renderStandardBrief(data.it.name, data.v.version, data.content as StandardContent)
        : null,
    linked: data.linked,
    package: data.pkg
      ? {
          hash: data.pkg.packageHash,
          totalBytes: data.pkg.totalBytes,
          files: data.pkg.manifest,
          declared: data.pkg.declared,
        }
      : null,
    skillMd,
    frontmatter,
    blockers: data.blockers,
    verified: data.it.kind === "standard" ? (data.content as StandardContent).checks.length > 0 : null,
  };
}

/** The text an agent session receives for a standard (never skill bodies). */
export function renderStandardBrief(name: string, version: number, c: StandardContent): string {
  const lines = [`${name} (v${version})${c.purpose ? ` — ${c.purpose}` : ""}`];
  for (const r of c.requirements) lines.push(`- [${r.level === "required" ? "required" : "recommended"}] ${r.text}`);
  if (c.checks.length === 0) lines.push("(Unverified guidance: no check is attached.)");
  return lines.join("\n");
}

/** Cmd-K: published, non-archived catalog items by name or slug. */
export async function searchCatalog(orgId: string, q: string) {
  const term = q.trim().slice(0, 100);
  if (!term) return { items: [] };
  const { ilike, or, isNull } = await import("drizzle-orm");
  return withOrg(orgId, async (tx) => {
    const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const rows = await tx
      .select({ id: catalogItems.id, kind: catalogItems.kind, name: catalogItems.name, slug: catalogItems.slug })
      .from(catalogItems)
      .where(and(eq(catalogItems.orgId, orgId), isNull(catalogItems.archivedAt), or(ilike(catalogItems.name, like), ilike(catalogItems.slug, like))))
      .limit(8);
    return { items: rows };
  });
}

/** Requirements of each standard's latest PUBLISHED version — for linking checks by picking, not typing keys. */
export async function listRequirements(orgId: string) {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ versionId: itemVersions.id, itemId: itemVersions.itemId, version: itemVersions.version, content: itemVersions.content, name: catalogItems.name })
      .from(itemVersions)
      .innerJoin(catalogItems, eq(catalogItems.id, itemVersions.itemId))
      .where(and(eq(itemVersions.orgId, orgId), eq(itemVersions.state, "published"), eq(catalogItems.kind, "standard")));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if ((latest.get(r.itemId)?.version ?? 0) < r.version) latest.set(r.itemId, r);
    return {
      requirements: [...latest.values()].flatMap((r) =>
        (r.content as StandardContent).requirements.map((q) => ({ key: q.key!, text: q.text, standard: `${r.name} v${r.version}`, versionId: r.versionId })),
      ),
    };
  });
}
