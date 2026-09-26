import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../env.js";
import { ensureMember, ensureProjectVisible, workerAuthed } from "../guards.js";
import { decideException, expireExceptions, listExceptions, requestException, type ExceptionRequest } from "../../standards/exceptions.js";
import { actOnFinding, checkDocument, listChecks } from "../../standards/checks.js";
import { conceptStandards } from "../../standards/briefing.js";
import { getOrgRole } from "../../standards/org-authority.js";
import { StorageNotConfigured } from "../../storage/blob.js";
import {
  OrgError,
  createTeam,
  deleteTeam,
  listOrgRoles,
  listTeams,
  orgMe,
  setOrgRole,
  setTeamMember,
  type OrgRole,
} from "../../standards/org-authority.js";
import {
  createItem,
  diffVersions,
  getItem,
  listCatalog,
  previewVersion,
  proposeVersion,
  publishVersion,
  saveDraft,
  searchCatalog,
  listRequirements,
  setArchived,
  type Kind,
} from "../../standards/catalog.js";
import { PackageError, storePackage } from "../../standards/packages.js";
import { checkUpstream, draftFromUpstream, importGithubSkill } from "../../standards/imports.js";
import { discoverSkills } from "../../standards/github-import.js";
import {
  createAssignment,
  createRelease,
  projectStandards,
  whyThisApplies,
} from "../../standards/applicability.js";
import { withOrg } from "../../db/rls.js";
import { resolveSession } from "../session-context.js";
import {
  blobForEnv,
  enrollEnvironment,
  myEnvironments,
  recordReceipts,
  setSkillPreference,
  syncPayload,
  unenrollEnvironment,
  projectEnvironments,
} from "../../standards/environments.js";
import type { SessionContext } from "../session-context.js";
import { applyChange, assignmentAdoption, listAssignments, previewChange, type Change } from "../../standards/rollouts.js";
import type { Selectors } from "../../db/schema.js";

const KINDS: Kind[] = ["standard", "skill", "check"];
const O = "/orgs/:orgId";

async function member(req: FastifyRequest, reply: FastifyReply): Promise<{ orgId: string; memberId: string } | null> {
  const { orgId } = req.params as { orgId: string };
  const memberId = await ensureMember(req, reply, orgId);
  return memberId ? { orgId, memberId } : null;
}

async function run<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof OrgError || e instanceof PackageError || e instanceof StorageNotConfigured) {
      reply.code(e.statusCode).send({ error: e.message });
      return undefined;
    }
    throw e;
  }
}

/**
 * Draft files may also say `{path, fromSha}`: keep an unchanged file (e.g. a binary) from the item's
 * current package by its hash, so editing text in the browser never drops the rest of the package.
 */
async function withKeptFiles(orgId: string, itemId: string, raw: unknown): Promise<Array<{ path: string; bytes: Uint8Array; mode?: number }> | null> {
  if (!Array.isArray(raw)) return null;
  const kept = raw.filter((f) => typeof (f as { fromSha?: unknown }).fromSha === "string") as Array<{ path: string; fromSha: string; mode?: number }>;
  const fresh = decodeFiles(raw.filter((f) => typeof (f as { fromSha?: unknown }).fromSha !== "string")) ?? [];
  if (!kept.length) return fresh;
  const { getItem } = await import("../../standards/catalog.js");
  const { skillPackages } = await import("../../db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { blobStore } = await import("../../storage/blob.js");
  const latest = (await getItem(orgId, itemId)).versions[0];
  const manifest = latest?.packageId
    ? ((await withOrg(orgId, async (tx) => (await tx.select().from(skillPackages).where(eq(skillPackages.id, latest.packageId!)).limit(1))[0]?.manifest)) ?? [])
    : [];
  const out = [...fresh];
  for (const k of kept) {
    const f = manifest.find((m) => m.sha256 === k.fromSha);
    if (!f) throw new PackageError(`kept file ${k.path} isn't in this skill's current package`);
    out.push({ path: k.path, bytes: await blobStore().get(orgId, f.sha256), mode: f.mode });
  }
  return out;
}

/** Skill files arrive base64-encoded: [{path, contentBase64, mode?}]. */
function decodeFiles(raw: unknown): Array<{ path: string; bytes: Uint8Array; mode?: number }> | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((f) => {
    const x = f as { path?: unknown; contentBase64?: unknown; mode?: unknown };
    if (typeof x.path !== "string" || typeof x.contentBase64 !== "string")
      throw new PackageError("each file needs path and contentBase64");
    return {
      path: x.path,
      bytes: new Uint8Array(Buffer.from(x.contentBase64, "base64")),
      mode: typeof x.mode === "number" ? x.mode : undefined,
    };
  });
}

/** Standards & Skills (milestone 1): org authority, catalog, import, applicability. */
export async function standardsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/standards/capabilities", async () => ({ standards: env.LOCKSTEP_STANDARDS }));
  // Worker: hourly exception expiry (a no-op while the feature is off).
  app.post("/internal/standards/exceptions/expire", async (req, reply) => {
    if (!workerAuthed(req, reply)) return;
    return env.LOCKSTEP_STANDARDS ? expireExceptions() : { expired: 0 };
  });

  // Every other route in this (encapsulated) plugin is invisible while the feature flag is off.
  app.addHook("onRequest", async (req, reply) => {
    const open = ["/standards/capabilities", "/internal/standards/exceptions/expire"];
    if (!env.LOCKSTEP_STANDARDS && !open.includes(req.routeOptions.url ?? "")) {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  const route = <T>(
    method: "get" | "post" | "put" | "delete",
    url: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
    opts: { bodyLimit?: number } = {},
  ) => {
    app[method](url, opts, handler);
  };

  /* ── organization authority ── */
  route("get", `${O}/me`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    return orgMe(c.orgId, c.memberId);
  });
  route("get", `${O}/roles`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    return { roles: await listOrgRoles(c.orgId) };
  });
  route("put", `${O}/roles/:memberId`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { memberId } = req.params as { memberId: string };
    const b = req.body as { role?: unknown };
    const role = b?.role === null ? null : b?.role === "owner" || b?.role === "admin" ? (b.role as OrgRole) : undefined;
    if (role === undefined) return reply.code(400).send({ error: "role must be owner, admin or null" });
    return run(reply, async () => (await setOrgRole(c.orgId, c.memberId, memberId, role), { ok: true }));
  });
  route("get", `${O}/teams`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    return { teams: await listTeams(c.orgId) };
  });
  route("post", `${O}/teams`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const b = req.body as { name?: unknown };
    if (typeof b?.name !== "string") return reply.code(400).send({ error: "name required" });
    return run(reply, () => createTeam(c.orgId, c.memberId, b.name as string));
  });
  route("delete", `${O}/teams/:teamId`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { teamId } = req.params as { teamId: string };
    return run(reply, async () => (await deleteTeam(c.orgId, c.memberId, teamId), { ok: true }));
  });
  for (const method of ["put", "delete"] as const) {
    route(method, `${O}/teams/:teamId/members/:memberId`, async (req, reply) => {
      const c = await member(req, reply);
      if (!c) return;
      const { teamId, memberId } = req.params as { teamId: string; memberId: string };
      return run(
        reply,
        async () => (await setTeamMember(c.orgId, c.memberId, teamId, memberId, method === "put"), { ok: true }),
      );
    });
  }

  /* ── catalog ── */
  route("get", `${O}/catalog`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { kind, archived } = req.query as { kind?: string; archived?: string };
    return {
      items: await listCatalog(c.orgId, {
        kind: KINDS.includes(kind as Kind) ? (kind as Kind) : undefined,
        archived: archived === "1",
      }),
    };
  });
  route(
    "post",
    `${O}/catalog`,
    async (req, reply) => {
      const c = await member(req, reply);
      if (!c) return;
      const b = req.body as { kind?: unknown; name?: unknown; content?: unknown; files?: unknown };
      if (!KINDS.includes(b?.kind as Kind) || typeof b?.name !== "string")
        return reply.code(400).send({ error: "kind and name required" });
      return run(reply, async () => {
        const files = b.kind === "skill" ? decodeFiles(b.files) : null;
        const pkg = files ? await storePackage(c.orgId, files, null) : null;
        return createItem(c.orgId, c.memberId, {
          kind: b.kind as Kind,
          name: b.name as string,
          content: b.content,
          packageId: pkg?.id ?? null,
        });
      });
    },
    { bodyLimit: 8_000_000 },
  );
  route("get", `${O}/catalog/items/:itemId`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { itemId } = req.params as { itemId: string };
    return run(reply, () => getItem(c.orgId, itemId));
  });
  route(
    "put",
    `${O}/catalog/items/:itemId/draft`,
    async (req, reply) => {
      const c = await member(req, reply);
      if (!c) return;
      const { itemId } = req.params as { itemId: string };
      const b = req.body as { content?: unknown; files?: unknown; expected?: { versionId?: unknown; reviewHash?: unknown } };
      const e = b?.expected;
      const expected = e && typeof e.versionId === "string" && typeof e.reviewHash === "string" ? { versionId: e.versionId, reviewHash: e.reviewHash } : undefined;
      return run(reply, async () => {
        const files = await withKeptFiles(c.orgId, itemId, b?.files);
        const pkg = files ? await storePackage(c.orgId, files, null) : null;
        return saveDraft(c.orgId, c.memberId, itemId, { content: b?.content, ...(pkg ? { packageId: pkg.id } : {}), expected });
      });
    },
    { bodyLimit: 8_000_000 },
  );
  route("post", `${O}/catalog/items/:itemId/archive`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { itemId } = req.params as { itemId: string };
    const b = req.body as { archived?: unknown };
    return run(
      reply,
      async () => (await setArchived(c.orgId, c.memberId, itemId, b?.archived !== false), { ok: true }),
    );
  });
  route("post", `${O}/catalog/versions/:versionId/propose`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { versionId } = req.params as { versionId: string };
    return run(reply, async () => (await proposeVersion(c.orgId, c.memberId, versionId), { ok: true }));
  });
  route("post", `${O}/catalog/versions/:versionId/publish`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { versionId } = req.params as { versionId: string };
    const expectedHash = (req.body as { expectedHash?: unknown } | undefined)?.expectedHash;
    if (typeof expectedHash !== "string")
      return reply.code(400).send({ error: "expectedHash required — publish what you reviewed (from the preview)" });
    return run(reply, () => publishVersion(c.orgId, c.memberId, versionId, expectedHash));
  });
  route("get", `${O}/catalog/versions/:versionId/preview`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { versionId } = req.params as { versionId: string };
    return run(reply, () => previewVersion(c.orgId, versionId));
  });
  route("get", `${O}/catalog/diff`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { from, to } = req.query as { from?: string; to?: string };
    if (!from || !to) return reply.code(400).send({ error: "from and to version ids required" });
    return run(reply, () => diffVersions(c.orgId, from, to));
  });

  /* ── GitHub import (public repos) ── */
  route("post", `${O}/catalog/import/discover`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const b = req.body as { url?: unknown };
    if (typeof b?.url !== "string") return reply.code(400).send({ error: "url required" });
    return run(reply, () => discoverSkills(b.url as string));
  });
  route("post", `${O}/catalog/import`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const b = req.body as { url?: unknown; commit?: unknown; ref?: unknown; dir?: unknown };
    if (typeof b?.url !== "string" || typeof b?.commit !== "string" || typeof b?.dir !== "string") {
      return reply.code(400).send({ error: "url, commit and dir required" });
    }
    return run(reply, () =>
      importGithubSkill(c.orgId, c.memberId, {
        url: b.url as string,
        commit: b.commit as string,
        ref: typeof b.ref === "string" ? b.ref : "",
        dir: b.dir as string,
      }),
    );
  });
  route("get", `${O}/catalog/versions/:versionId/upstream`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { versionId } = req.params as { versionId: string };
    return run(reply, () => checkUpstream(c.orgId, versionId));
  });
  route("post", `${O}/catalog/versions/:versionId/upstream`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { versionId } = req.params as { versionId: string };
    const b = req.body as { commit?: unknown };
    if (typeof b?.commit !== "string") return reply.code(400).send({ error: "commit required" });
    return run(reply, () => draftFromUpstream(c.orgId, c.memberId, versionId, b.commit as string));
  });

  /* ── releases + assignments (data in M1; rollout mechanics in M2) ── */
  route("post", `${O}/releases`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const b = req.body as { name?: unknown; versionIds?: unknown };
    if (!Array.isArray(b?.versionIds) || !b.versionIds.every((x) => typeof x === "string"))
      return reply.code(400).send({ error: "versionIds required" });
    return run(reply, () =>
      createRelease(c.orgId, c.memberId, typeof b.name === "string" ? b.name : "", b.versionIds as string[]),
    );
  });
  route("get", `${O}/assignments`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    // Org-wide rollout metadata (scopes, other people's checkouts) is for owners/admins; members
    // see their own status (/me/environments) and projects they can read (Standards tab).
    if (!(await getOrgRole(c.orgId, c.memberId))) return reply.code(403).send({ error: "requires org owner or admin" });
    return listAssignments(c.orgId);
  });
  route("get", `${O}/assignments/:assignmentId/adoption`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { assignmentId } = req.params as { assignmentId: string };
    if (!(await getOrgRole(c.orgId, c.memberId))) return reply.code(403).send({ error: "requires org owner or admin" });
    return run(reply, () => assignmentAdoption(c.orgId, assignmentId));
  });

  /* ── rollouts: every change is previewed, then applied (owner/admin) ── */
  for (const step of ["preview", "apply"] as const) {
    route("post", `${O}/rollouts/${step}`, async (req, reply) => {
      const c = await member(req, reply);
      if (!c) return;
      const { change, basis } = (req.body ?? {}) as { change?: Change; basis?: unknown };
      const kinds = ["create", "revise", "rollback", "retire", "withdraw"];
      if (!change || typeof change !== "object" || !kinds.includes(change.kind))
        return reply.code(400).send({ error: `change.kind must be one of ${kinds.join(", ")}` });
      if (step === "apply" && typeof basis !== "string")
        return reply.code(400).send({ error: "basis required — apply the change you previewed" });
      return run(reply, (): Promise<unknown> =>
        step === "preview" ? previewChange(c.orgId, c.memberId, change) : applyChange(c.orgId, c.memberId, change, basis as string),
      );
    });
  }
  route("get", `${O}/me/environments`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    return { environments: await myEnvironments(c.orgId, c.memberId) };
  });

  /* ── environments (CLI; authenticated by the agent session) ── */
  const session = async (req: FastifyRequest, reply: FastifyReply): Promise<SessionContext | null> => {
    const sid = req.headers["x-lockstep-session"];
    if (!req.principal) return (reply.code(401).send({ error: "unauthorized" }), null);
    if (typeof sid !== "string") return (reply.code(400).send({ error: "x-lockstep-session header required" }), null);
    const s = await resolveSession(req.principal, sid);
    if (!s) return (reply.code(403).send({ error: "invalid session" }), null);
    return s;
  };
  const envId = (req: FastifyRequest) => (req.params as { envId: string }).envId;
  const who = (s: SessionContext) => ({ memberId: s.memberId, repoId: s.repoId });
  route("post", "/environments/enroll", async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as { adapter?: string; adapterVersion?: string; hostKey?: string; capabilities?: Record<string, unknown> };
    if (typeof b.adapter !== "string" || typeof b.hostKey !== "string")
      return reply.code(400).send({ error: "adapter and hostKey required" });
    return run(reply, () =>
      enrollEnvironment(s, {
        adapter: b.adapter!,
        adapterVersion: typeof b.adapterVersion === "string" ? b.adapterVersion : undefined,
        hostKey: b.hostKey!,
        capabilities: b.capabilities as never,
      }),
    );
  });
  route("post", "/environments/:envId/unenroll", async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return;
    return run(reply, async () => (await unenrollEnvironment(s.orgId, envId(req), who(s)), { ok: true }));
  });
  route("get", "/environments/:envId/sync", async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return;
    return run(reply, () => syncPayload(s.orgId, envId(req), who(s)));
  });
  route("get", "/environments/:envId/blobs/:sha", async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return;
    const { sha } = req.params as { sha: string };
    const bytes = await run(reply, () => blobForEnv(s.orgId, envId(req), who(s), sha));
    if (bytes) return reply.type("application/octet-stream").send(Buffer.from(bytes));
  });
  route("post", "/environments/:envId/receipts", async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as { generation?: string; results?: unknown };
    return run(reply, () =>
      recordReceipts(s.orgId, envId(req), who(s), {
        generation: b.generation as string,
        sessionId: s.sessionId,
        results: b.results as never,
      }),
    );
  });
  route("post", "/environments/:envId/preferences", async (req, reply) => {
    const s = await session(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as { itemId?: string; choice?: string };
    if (typeof b.itemId !== "string" || !["accept", "decline", "reset"].includes(b.choice ?? ""))
      return reply.code(400).send({ error: "itemId and choice (accept|decline|reset) required" });
    return run(reply, async () => (await setSkillPreference(s.orgId, envId(req), who(s), b.itemId!, b.choice as "accept"), { ok: true }));
  });
  route("post", `${O}/assignments`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const b = req.body as {
      name?: unknown;
      releaseId?: unknown;
      selectors?: unknown;
      level?: unknown;
      pilot?: unknown;
    };
    if (typeof b?.releaseId !== "string" || typeof b?.selectors !== "object" || !b.selectors)
      return reply.code(400).send({ error: "releaseId and selectors required" });
    if (b.level !== "required" && b.level !== "recommended")
      return reply.code(400).send({ error: "level must be required or recommended" });
    return run(reply, () =>
      createAssignment(c.orgId, c.memberId, {
        name: typeof b.name === "string" ? b.name : "",
        releaseId: b.releaseId as string,
        selectors: b.selectors as Selectors,
        level: b.level as "required" | "recommended",
        pilot: (b.pilot as Selectors | null | undefined) ?? null,
      }),
    );
  });

  /* ── project views (existing project access still required) ── */
  route("get", `${O}/projects/:projectId/standards`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { projectId } = req.params as { projectId: string };
    if (!(await ensureProjectVisible(reply, c.orgId, projectId, c.memberId))) return;
    return projectStandards(c.orgId, projectId);
  });
  route("get", `${O}/projects/:projectId/standards/why`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { projectId } = req.params as { projectId: string };
    if (!(await ensureProjectVisible(reply, c.orgId, projectId, c.memberId))) return;
    const q = req.query as { repoId?: string; paths?: string; taskType?: string };
    const taskType = q.taskType === "code" || q.taskType === "prd" ? q.taskType : null;
    return run(reply, () =>
      whyThisApplies(c.orgId, projectId, c.memberId, {
        repoId: q.repoId || null,
        paths: q.paths
          ? q.paths
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
              .slice(0, 200)
          : null,
        taskType,
      }),
    );
  });

  /* ── exceptions (members request; owners/admins decide) ── */
  route("get", `${O}/exceptions`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { projectId } = req.query as { projectId?: string };
    const role = await getOrgRole(c.orgId, c.memberId);
    const rows = await listExceptions(c.orgId, { projectId });
    // Members see their own requests; org metadata beyond that is for owners/admins.
    return { exceptions: role ? rows : rows.filter((x) => x.requestedById === c.memberId), canDecide: Boolean(role) };
  });
  route("post", `${O}/exceptions`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as Partial<ExceptionRequest>;
    if ((b.target !== "requirement" && b.target !== "skill_assignment") || typeof b.versionId !== "string" || typeof b.reason !== "string")
      return reply.code(400).send({ error: "target, versionId and reason required" });
    if (b.scope?.projectId && !(await ensureProjectVisible(reply, c.orgId, b.scope.projectId, c.memberId))) return;
    return run(reply, () => requestException(c.orgId, c.memberId, { ...(b as ExceptionRequest), scope: b.scope ?? {} }));
  });
  route("post", `${O}/exceptions/:exceptionId/decide`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    const { exceptionId } = req.params as { exceptionId: string };
    const b = (req.body ?? {}) as { approve?: unknown; note?: unknown };
    if (typeof b.approve !== "boolean") return reply.code(400).send({ error: "approve (boolean) required" });
    return run(reply, async () => (await decideException(c.orgId, c.memberId, exceptionId, b.approve as boolean, typeof b.note === "string" ? b.note : undefined), { ok: true }));
  });

  /* ── artifact checks (project access required) ── */
  const projectMember = async (req: FastifyRequest, reply: FastifyReply) => {
    const c = await member(req, reply);
    if (!c) return null;
    const { projectId } = req.params as { projectId: string };
    if (!(await ensureProjectVisible(reply, c.orgId, projectId, c.memberId))) return null;
    return { ...c, projectId };
  };
  route("get", `${O}/projects/:projectId/concepts/:conceptId/standards`, async (req, reply) => {
    const c = await projectMember(req, reply);
    if (!c) return;
    return conceptStandards(c.orgId, c.projectId, (req.params as { conceptId: string }).conceptId, c.memberId);
  });
  route("get", `${O}/projects/:projectId/standards/environments`, async (req, reply) => {
    const c = await projectMember(req, reply);
    if (!c) return;
    return projectEnvironments(c.orgId, c.projectId);
  });
  route("get", `${O}/catalog/requirements`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    return listRequirements(c.orgId);
  });
  route("get", `${O}/catalog/search`, async (req, reply) => {
    const c = await member(req, reply);
    if (!c) return;
    return searchCatalog(c.orgId, String((req.query as { q?: string }).q ?? ""));
  });
  route("get", `${O}/projects/:projectId/standards/checks`, async (req, reply) => {
    const c = await projectMember(req, reply);
    if (!c) return;
    return listChecks(c.orgId, c.projectId);
  });
  route("post", `${O}/projects/:projectId/standards/checks`, async (req, reply) => {
    const c = await projectMember(req, reply);
    if (!c) return;
    const b = (req.body ?? {}) as { documentId?: unknown; hostedReview?: unknown };
    if (typeof b.documentId !== "string") return reply.code(400).send({ error: "documentId required" });
    return run(reply, () => checkDocument(c.orgId, c.projectId, c.memberId, { documentId: b.documentId as string, hostedReview: b.hostedReview === true }));
  });
  route("post", `${O}/projects/:projectId/standards/checks/:checkId/findings`, async (req, reply) => {
    const c = await projectMember(req, reply);
    if (!c) return;
    const { checkId } = req.params as { checkId: string };
    const b = (req.body ?? {}) as { findingKey?: unknown; action?: unknown; rationale?: unknown; expiresAt?: unknown };
    if (typeof b.findingKey !== "string" || (b.action !== "dismiss" && b.action !== "exception_requested") || typeof b.rationale !== "string")
      return reply.code(400).send({ error: "findingKey, action (dismiss|exception_requested) and rationale required" });
    return run(reply, () =>
      actOnFinding(c.orgId, c.projectId, c.memberId, {
        checkId,
        findingKey: b.findingKey as string,
        action: b.action as "dismiss",
        rationale: b.rationale as string,
        expiresAt: typeof b.expiresAt === "string" ? b.expiresAt : null,
      }),
    );
  });
}
