"use server";

import { revalidatePath } from "next/cache";
import { apiGet, apiPostRaw } from "@/lib/api";

export interface AdoptionState { error?: string; message?: string; href?: string }
export interface Brief { markdown: string; hash: string; accepted: number; proposed: number }

async function post(path: string, body: unknown) {
  const response = await apiPostRaw(path, body);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export async function createPilotAction(_prev: AdoptionState, form: FormData): Promise<AdoptionState> {
  try {
    const result = await post("/pilot/projects", { name: String(form.get("name") ?? "") });
    revalidatePath("/");
    return { href: `/project/${result.orgId}/${result.projectId}/sources`, message: "Project created. Paste your first brief." };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not create project." }; }
}

export async function saveBriefAction(_prev: AdoptionState, form: FormData): Promise<AdoptionState> {
  const orgId = String(form.get("orgId"));
  const projectId = String(form.get("projectId"));
  const base = `/project/${orgId}/${projectId}`;
  try {
    const result = await post(`/orgs/${orgId}/projects/${projectId}/native-documents`, {
      title: String(form.get("title") ?? ""), content: String(form.get("content") ?? ""),
      featureRef: String(form.get("featureRef") || "") || undefined,
      documentId: String(form.get("documentId") || "") || undefined,
      baseVersion: form.get("baseVersion") ? Number(form.get("baseVersion")) : undefined,
      manualRules: String(form.get("manualRules") || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean),
    });
    revalidatePath(base, "layout");
    return { href: `${base}/sources/${result.documentId}`, message: `Saved version ${result.version}. ${result.status === "unavailable" ? "Extraction unavailable. Open the saved brief to select requirements manually." : `${result.proposals} requirements processed. Review their current status below.`}${result.partial ? " Some source content exceeded the extraction limits; review the complete source." : ""}` };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not save brief." }; }
}

export async function previewBrief(orgId: string, projectId: string, filters: Record<string, string>): Promise<Brief | null> {
  return apiGet<Brief>(`/orgs/${orgId}/projects/${projectId}/brief?${new URLSearchParams(filters)}`);
}
export async function recordExport(orgId: string, projectId: string, hash: string, filters: Record<string, string>) {
  await post(`/orgs/${orgId}/projects/${projectId}/brief/exported`, { hash, filters });
}
export async function feedbackAction(orgId: string, projectId: string, checkId: string, decisionId: string, verdict: string) {
  try {
    await post(`/orgs/${orgId}/projects/${projectId}/checks/${checkId}/feedback`, { decisionId, verdict });
    revalidatePath(`/project/${orgId}/${projectId}`, "layout");
    return { message: "Feedback saved. The decision is unchanged." };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not save feedback." }; }
}
