"use server";
import { apiGet } from "./lib/api";
/** Server actions for the concept-ledger shell: human edits + paginated reads for client components. */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getConceptGraph, getOutlineDomain, getOutlineGroup, getSurfaceHistory, searchProject } from "./lib/next-data";

const P = (orgId: string, projectId: string) => `/orgs/${orgId}/projects/${projectId}`;
const base = (orgId: string, projectId: string) => `/project/${orgId}/${projectId}`;

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

async function post(path: string, body: unknown, method = "POST"): Promise<ActionResult> {
  const t = cookies().get("lockstep_token")?.value;
  const res = await fetch(`${API}${path}`, {
    method,
    // Fastify rejects an empty body declared as JSON, so a bodiless DELETE sends no content-type
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { ok: false, error: "API unreachable" };
  if (res.ok) return { ok: true };
  const b = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: b.error ?? `request failed (${res.status})` };
}

/** Every page of the project can show the changed item (inbox, map, ledger, decision pages). */
function refresh(orgId: string, projectId: string): void {
  revalidatePath(base(orgId, projectId), "layout");
}

export async function renameConceptAction(orgId: string, projectId: string, conceptId: string, label: string) {
  const r = await post(`${P(orgId, projectId)}/concepts/${conceptId}/rename`, { label });
  refresh(orgId, projectId);
  return r;
}
export async function setConceptDomainAction(orgId: string, projectId: string, conceptId: string, domainId: string) {
  const r = await post(`${P(orgId, projectId)}/concepts/${conceptId}/domain`, { domainId });
  refresh(orgId, projectId);
  return r;
}
export async function mergeConceptAction(orgId: string, projectId: string, conceptId: string, intoId: string) {
  const r = await post(`${P(orgId, projectId)}/concepts/${conceptId}/merge`, { intoId });
  refresh(orgId, projectId);
  return r;
}
export async function placeItemAction(
  orgId: string,
  projectId: string,
  itemKind: "surface" | "decision",
  itemId: string,
  target: { conceptId: string } | { projectWide: true },
) {
  const r = await post(`${P(orgId, projectId)}/placements`, { itemKind, itemId, ...target });
  refresh(orgId, projectId);
  return r;
}
export async function createDomainAction(orgId: string, projectId: string, label: string) {
  const r = await post(`${P(orgId, projectId)}/domains`, { label });
  refresh(orgId, projectId);
  return r;
}
export async function updateDomainAction(
  orgId: string,
  projectId: string,
  domainId: string,
  patch: { label?: string; position?: number },
) {
  const r = await post(`${P(orgId, projectId)}/domains/${domainId}`, patch, "PATCH");
  refresh(orgId, projectId);
  return r;
}
export async function deleteDomainAction(orgId: string, projectId: string, domainId: string) {
  const r = await post(`${P(orgId, projectId)}/domains/${domainId}`, undefined, "DELETE");
  refresh(orgId, projectId);
  return r;
}
export async function setHttpRulesAction(orgId: string, projectId: string, skip: string[]) {
  const r = await post(`${P(orgId, projectId)}/concept-rules`, { skip }, "PUT");
  refresh(orgId, projectId);
  return r;
}
export async function rebuildConceptsAction(orgId: string, projectId: string) {
  const r = await post(`${P(orgId, projectId)}/concepts/rebuild`, {});
  refresh(orgId, projectId);
  return r;
}

/* reads for client components (load more / palette / lazy history / graph expansion) */
export async function loadDomainPageAction(orgId: string, projectId: string, domainId: string, cursor: string) {
  return getOutlineDomain(orgId, projectId, domainId, cursor);
}
export async function loadGroupPageAction(orgId: string, projectId: string, group: string, cursor?: string) {
  return getOutlineGroup(orgId, projectId, group, cursor);
}
export async function loadSurfaceHistoryAction(orgId: string, projectId: string, surfaceId: string, cursor?: string) {
  return getSurfaceHistory(orgId, projectId, surfaceId, cursor);
}
export async function searchAction(orgId: string, projectId: string, q: string) {
  const [r, cat] = await Promise.all([
    searchProject(orgId, projectId, q),
    process.env.LOCKSTEP_STANDARDS === "1" && q.trim()
      ? apiGet<{ items: Array<{ id: string; kind: string; name: string; slug: string }> }>(
          `/orgs/${orgId}/catalog/search?q=${encodeURIComponent(q)}`,
        )
      : null,
  ]);
  return r ? { ...r, standards: cat?.items ?? [] } : r;
}
export async function loadGraphAction(
  orgId: string,
  projectId: string,
  expand?: string,
  cursor?: string,
  focus?: string,
) {
  return getConceptGraph(orgId, projectId, expand, cursor, focus);
}

const noteOf = (f: FormData): { note?: string } => {
  const n = String(f.get("note") ?? "").trim();
  return n ? { note: n.slice(0, 1000) } : {};
};

/* Inbox inline actions — same API endpoints the review queue uses, revalidating the new routes. */
const INBOX_OPS: Record<string, (orgId: string, id: string, f: FormData, projectId: string) => [string, unknown]> = {
  ack: (o, id, f, p) => [
    `/orgs/${o}/projects/${p}/decisions/${id}/ack`,
    { version: Number(f.get("version") ?? 0), verdict: "ack" },
  ],
  // the optional note travels with the verdict and is posted back to the decision's source
  confirm: (o, id, f) => [`/orgs/${o}/decisions/${id}/confirm`, noteOf(f)],
  reject: (o, id, f) => [`/orgs/${o}/decisions/${id}/reject`, noteOf(f)],
  ratify: (o, id, f) => [`/orgs/${o}/decisions/${id}/ratify`, noteOf(f)],
  holds: (o, id) => [`/orgs/${o}/conflicts/${id}/resolve`, { resolution: "holds" }],
  // a suggested placement confirmed as-is (pins its location)
  place: (o, _id, f, p) => [
    `/orgs/${o}/projects/${p}/placements`,
    { itemKind: "decision", itemId: String(f.get("itemId")), conceptId: String(f.get("conceptId")) },
  ],
  dismiss: (o, id) => [`/orgs/${o}/conflicts/${id}/resolve`, { resolution: "dismiss" }],
  reviewed: (o, id) => [`/orgs/${o}/decisions/${id}/review`, { reviewAt: null }],
};

/** API refusals an approver can act on, in plain words. Anything else passes through as sent. */
const VERDICT_ERRORS: Array<[RegExp, string]> = [
  [
    /no source document/,
    "This constraint isn’t linked to a source document, so it can’t be ratified. Reject it, or re-import it from its PRD.",
  ],
  [/document_not_active/, "Its source document isn’t Active yet. Move the PRD to Active, then ratify."],
  [/owner\/pm role|insufficient_role/, "Only a project owner or PM (or the document’s owner) can do this."],
  [/not proposed|, not open/, "This decision already moved on — refresh to see its current state."],
  [/stale base_version/, "Someone changed this decision meanwhile — refresh and try again."],
];
const plain = (e?: string) => VERDICT_ERRORS.find(([re]) => e && re.test(e))?.[1] ?? e ?? "That didn’t work.";

/** A verdict (ratify / confirm / reject / ack / resolve / place / reviewed) that reports its outcome. */
export async function verdictAction(
  orgId: string,
  projectId: string,
  id: string,
  opName: string,
  extra: Record<string, string> = {},
): Promise<ActionResult> {
  const op = INBOX_OPS[opName];
  if (!op || !orgId || !id) return { ok: false, error: "Unknown action." };
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  const [path, body] = op(orgId, id, f, projectId);
  const r = await post(path, body);
  if (r.ok) refresh(orgId, projectId);
  return r.ok ? r : { ok: false, error: plain(r.error) };
}

export async function inboxAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  const op = INBOX_OPS[String(formData.get("op") ?? "")];
  if (!op || !orgId || !id) return;
  const [path, body] = op(orgId, id, formData, projectId);
  await post(path, body);
  refresh(orgId, projectId);
}

/** Generated "why raised" summary for the approval brief (cached per version server-side). */
export async function briefSummaryAction(orgId: string, projectId: string, decisionId: string) {
  const t = cookies().get("lockstep_token")?.value;
  const res = await fetch(`${API}/orgs/${orgId}/projects/${projectId}/decisions/${decisionId}/brief/summary`, {
    method: "POST",
    headers: t ? { authorization: `Bearer ${t}` } : {},
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { summary: { text: string; model: string } | null }).summary;
}
