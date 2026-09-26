"use server";
/** Server actions for the Organization workspace. Each reports its outcome — never fails silently. */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { Kind, RolloutPreview, SelectorsIn } from "./lib/org-data";

const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

export type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  const t = cookies().get("lockstep_token")?.value;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { ok: false, error: "The API is unreachable." };
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) return { ok: false, error: j.error ?? `Request failed (${res.status}).` };
  return { ok: true, data: j };
}

const O = (orgId: string) => `/orgs/${orgId}`;
const refresh = (orgId: string) => revalidatePath(`/org/${orgId}`, "layout");

export interface FileInput {
  path: string;
  content: string; // text files authored in the UI
  /** An unchanged (e.g. binary) file kept from the current package by hash. */
  keepSha?: string;
}
const toFiles = (files?: FileInput[]) =>
  files?.map((f) => (f.keepSha ? { path: f.path, fromSha: f.keepSha } : { path: f.path, contentBase64: Buffer.from(f.content, "utf8").toString("base64") }));

export async function createItemAction(orgId: string, kind: Kind, name: string, content: unknown, files?: FileInput[]) {
  const r = await call<{ itemId: string; versionId: string }>("POST", `${O(orgId)}/catalog`, {
    kind,
    name,
    content,
    files: toFiles(files),
  });
  refresh(orgId);
  return r;
}
/** `expected`: the version the editor shows — refused (409) if the item moved on since. */
export async function saveDraftAction(
  orgId: string,
  itemId: string,
  content: unknown,
  files?: FileInput[],
  expected?: { versionId: string; reviewHash: string },
) {
  const r = await call<{ versionId: string; version: number; reviewHash: string }>("PUT", `${O(orgId)}/catalog/items/${itemId}/draft`, {
    content,
    files: toFiles(files),
    expected,
  });
  refresh(orgId);
  return r;
}
export async function proposeAction(orgId: string, versionId: string) {
  const r = await call("POST", `${O(orgId)}/catalog/versions/${versionId}/propose`);
  refresh(orgId);
  return r;
}
/** Publishes only the exact content that was reviewed (`reviewHash` from the preview or save). */
export async function publishAction(orgId: string, versionId: string, reviewHash: string) {
  const r = await call<{ version: number }>("POST", `${O(orgId)}/catalog/versions/${versionId}/publish`, { expectedHash: reviewHash });
  refresh(orgId);
  return r;
}
export async function archiveAction(orgId: string, itemId: string, archived: boolean) {
  const r = await call("POST", `${O(orgId)}/catalog/items/${itemId}/archive`, { archived });
  refresh(orgId);
  return r;
}
export async function discoverAction(orgId: string, url: string) {
  return call<{
    source: { owner: string; repo: string };
    commit: string;
    ref: string;
    candidates: Array<{ dir: string; name: string; description: string }>;
  }>("POST", `${O(orgId)}/catalog/import/discover`, { url });
}
export async function importAction(orgId: string, input: { url: string; commit: string; ref: string; dir: string }) {
  const r = await call<{ itemId: string; versionId: string }>("POST", `${O(orgId)}/catalog/import`, input);
  refresh(orgId);
  return r;
}
export async function checkUpstreamAction(orgId: string, versionId: string) {
  return call<{
    status: "up_to_date" | "update_available" | "unavailable";
    currentCommit: string;
    candidateCommit?: string;
    files?: Array<{ path: string; change: string }>;
    reason?: string;
  }>("GET", `${O(orgId)}/catalog/versions/${versionId}/upstream`);
}
export async function draftFromUpstreamAction(orgId: string, versionId: string, commit: string) {
  const r = await call<{ versionId: string; version: number }>(
    "POST",
    `${O(orgId)}/catalog/versions/${versionId}/upstream`,
    { commit },
  );
  refresh(orgId);
  return r;
}
export async function setRoleAction(orgId: string, memberId: string, role: "owner" | "admin" | null) {
  const r = await call("PUT", `${O(orgId)}/roles/${memberId}`, { role });
  refresh(orgId);
  return r;
}
export async function createTeamAction(orgId: string, name: string) {
  const r = await call<{ id: string }>("POST", `${O(orgId)}/teams`, { name });
  refresh(orgId);
  return r;
}
export async function deleteTeamAction(orgId: string, teamId: string) {
  const r = await call("DELETE", `${O(orgId)}/teams/${teamId}`);
  refresh(orgId);
  return r;
}
export async function setTeamMemberAction(orgId: string, teamId: string, memberId: string, present: boolean) {
  const r = await call(present ? "PUT" : "DELETE", `${O(orgId)}/teams/${teamId}/members/${memberId}`);
  refresh(orgId);
  return r;
}

/* Rollouts: preview never writes; apply writes one immutable revision / retirement / withdrawal. */
export type RolloutChange =
  | {
      kind: "create";
      name?: string;
      versionIds: string[];
      selectors: SelectorsIn;
      level: "required" | "recommended";
      pilot?: SelectorsIn | null;
    }
  | {
      kind: "revise";
      assignmentId: string;
      versionIds?: string[];
      selectors?: SelectorsIn;
      level?: "required" | "recommended";
      pilot?: SelectorsIn | null;
    }
  | { kind: "rollback"; assignmentId: string; toRevision: number }
  | { kind: "retire"; assignmentId: string }
  | { kind: "withdraw"; releaseId: string; replacementReleaseId?: string | null; reason?: string };

export async function previewRolloutAction(orgId: string, change: RolloutChange) {
  return call<RolloutPreview>("POST", `${O(orgId)}/rollouts/preview`, { change });
}
/** Applies only against the state the preview was computed from (`basis`); otherwise 409. */
export async function applyRolloutAction(orgId: string, change: RolloutChange, basis: string) {
  const r = await call<{ assignmentId?: string; revision?: number }>("POST", `${O(orgId)}/rollouts/apply`, { change, basis });
  refresh(orgId);
  return r;
}

/* Checks + exceptions. Project pages revalidate their own paths. */
export async function checkDocumentAction(orgId: string, projectId: string, documentId: string, hostedReview: boolean) {
  const r = await call("POST", `${O(orgId)}/projects/${projectId}/standards/checks`, { documentId, hostedReview });
  revalidatePath(`/project/${orgId}/${projectId}`, "layout");
  return r;
}
export async function findingAction(
  orgId: string,
  projectId: string,
  checkId: string,
  findingKey: string,
  action: "dismiss" | "exception_requested",
  rationale: string,
  expiresAt?: string,
) {
  const r = await call("POST", `${O(orgId)}/projects/${projectId}/standards/checks/${checkId}/findings`, {
    findingKey,
    action,
    rationale,
    expiresAt: expiresAt || null,
  });
  revalidatePath(`/project/${orgId}/${projectId}`, "layout");
  refresh(orgId);
  return r;
}
export async function requestExceptionAction(
  orgId: string,
  input: {
    target: "requirement" | "skill_assignment";
    versionId: string;
    requirementKey?: string;
    scope: { projectId?: string; taskType?: string };
    reason: string;
    expiresAt?: string;
  },
) {
  const r = await call<{ id: string }>("POST", `${O(orgId)}/exceptions`, {
    ...input,
    expiresAt: input.expiresAt || null,
  });
  if (input.scope.projectId) revalidatePath(`/project/${orgId}/${input.scope.projectId}`, "layout");
  refresh(orgId);
  return r;
}
export async function decideExceptionAction(orgId: string, exceptionId: string, approve: boolean, note: string) {
  const r = await call("POST", `${O(orgId)}/exceptions/${exceptionId}/decide`, { approve, note });
  refresh(orgId);
  return r;
}
