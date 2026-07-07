"use server";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiPost, apiDelete } from "./lib/api";

export async function loginAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (token) cookies().set("lockstep_token", token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  cookies().delete("lockstep_token");
  redirect("/");
}

export async function createOrgAction(formData: FormData): Promise<void> {
  await apiPost("/orgs", { name: String(formData.get("name") ?? "") });
  revalidatePath("/");
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  await apiPost(`/orgs/${orgId}/projects`, { name: String(formData.get("name") ?? "") });
  revalidatePath("/");
}

export async function connectRepoAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/repos`, { gitRemote: String(formData.get("gitRemote") ?? "") });
  revalidatePath(`/project/${orgId}/${projectId}`);
}

export async function inviteAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const role = String(formData.get("role") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/invite`, {
    githubLogin: String(formData.get("githubLogin") ?? ""),
    ...(role ? { role } : {}),
  });
  revalidatePath(`/project/${orgId}/${projectId}`);
}

export async function setMemberSlackAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  const slackUserId = String(formData.get("slackUserId") ?? "").trim();
  await apiPost(`/orgs/${orgId}/projects/${projectId}/members/${memberId}/slack`, { slackUserId });
  revalidatePath(`/project/${orgId}/${projectId}/members`);
}

export async function setVisibilityAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const visibility = String(formData.get("visibility") ?? "shared");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/settings`, { visibility });
  revalidatePath(`/project/${orgId}/${projectId}/members`);
}

/* ── v2 ingestion: review queue + connections ── */

export async function confirmDecisionAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  await apiPost(`/orgs/${orgId}/decisions/${id}/confirm`, {});
  revalidatePath(`/project/${orgId}/${projectId}/review-queue`);
}

export async function rejectDecisionAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  await apiPost(`/orgs/${orgId}/decisions/${id}/reject`, {});
  revalidatePath(`/project/${orgId}/${projectId}/review-queue`);
}

export async function createConnectionAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/connections`, {
    tool: String(formData.get("tool") ?? "slack"),
  });
  revalidatePath(`/project/${orgId}/${projectId}/connections`);
}

export async function initiateConnectionAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const h = headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const callbackUrl = `${proto}://${host}/project/${orgId}/${projectId}/connections?connected=${connectionId}`;
  const res = await apiPost<{ redirectUrl?: string }>(
    `/orgs/${orgId}/projects/${projectId}/connections/${connectionId}/initiate`,
    { callbackUrl },
  );
  // redirect() throws NEXT_REDIRECT — must be outside any try/catch.
  redirect(res?.redirectUrl || `/project/${orgId}/${projectId}/connections?error=initiate_failed`);
}

export async function addAllowlistAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/allowlist`, {
    connectionId: String(formData.get("connectionId") ?? ""),
    sourceKind: String(formData.get("sourceKind") ?? "channel"),
    sourceRef: String(formData.get("sourceRef") ?? ""),
    sourceName: String(formData.get("sourceName") ?? ""),
  });
  revalidatePath(`/project/${orgId}/${projectId}/connections`);
}

export async function deriveGraphAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/graph/derive`, {});
  revalidatePath(`/project/${orgId}/${projectId}/graph`);
}

export async function addGraphEdgeAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/graph/edges`, {
    fromId: String(formData.get("fromId") ?? ""),
    toId: String(formData.get("toId") ?? ""),
    kind: String(formData.get("kind") ?? "relates"),
  });
  revalidatePath(`/project/${orgId}/${projectId}/graph`);
}

/* ── v3 product layer ── */

export async function ratifyDecisionAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  const ruleText = String(formData.get("ruleText") ?? "");
  const originalRuleText = String(formData.get("originalRuleText") ?? "");
  const edited = ruleText.trim() !== "" && ruleText !== originalRuleText;
  await apiPost(`/orgs/${orgId}/decisions/${id}/ratify`, edited ? { ruleText } : {});
  revalidatePath(`/project/${orgId}/${projectId}/review-queue`);
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
}

export async function registerDocumentAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const url = String(formData.get("url") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/documents`, { url });
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
}

export async function setDocumentStateAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const docId = String(formData.get("docId") ?? "");
  const state = String(formData.get("state") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/documents/${docId}/state`, { state });
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
  revalidatePath(`/project/${orgId}/${projectId}/sources/${docId}`);
}

export async function unregisterDocumentAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const docId = String(formData.get("docId") ?? "");
  await apiDelete(`/orgs/${orgId}/projects/${projectId}/documents/${docId}`);
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
}

export async function resyncDocumentAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const docId = String(formData.get("docId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/documents/${docId}/resync`, {});
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
  revalidatePath(`/project/${orgId}/${projectId}/sources/${docId}`);
}

export async function setStateMappingAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const containerRef = String(formData.get("containerRef") ?? "");
  const sourceValue = String(formData.get("sourceValue") ?? "");
  const canonicalState = String(formData.get("canonicalState") ?? "");
  if (sourceValue && canonicalState) {
    await apiPost(`/orgs/${orgId}/projects/${projectId}/connections/${connectionId}/state-mappings`, {
      containerRef,
      sourceValue,
      canonicalState,
    });
  }
  revalidatePath(`/project/${orgId}/${projectId}/connections`);
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
}

export async function setStatusPropertyAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/connections/${connectionId}/state-mappings/property`, {
    containerRef: String(formData.get("containerRef") ?? ""),
    statusProperty: String(formData.get("statusProperty") ?? ""),
  });
  revalidatePath(`/project/${orgId}/${projectId}/connections`);
  revalidatePath(`/project/${orgId}/${projectId}/sources`);
}

export async function confirmGovernsEdgeAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const edgeId = String(formData.get("edgeId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/graph/edges/${edgeId}/confirm`, {});
  revalidatePath(`/project/${orgId}/${projectId}/features`);
  revalidatePath(`/project/${orgId}/${projectId}/graph`);
}

export async function rejectGovernsEdgeAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const edgeId = String(formData.get("edgeId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/graph/edges/${edgeId}/reject`, {});
  revalidatePath(`/project/${orgId}/${projectId}/features`);
  revalidatePath(`/project/${orgId}/${projectId}/graph`);
}

export async function resolveConflictAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  const resolution = String(formData.get("resolution") ?? "");
  const reason = String(formData.get("reason") ?? "");
  await apiPost(`/orgs/${orgId}/conflicts/${id}/resolve`, {
    resolution,
    ...(reason ? { reason } : {}),
  });
  revalidatePath(`/project/${orgId}/${projectId}/review-queue`);
}

export async function updateMemberRoleAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const projectMemberId = String(formData.get("projectMemberId") ?? "");
  await apiPost(`/orgs/${orgId}/projects/${projectId}/members/${projectMemberId}/role`, {
    role: String(formData.get("role") ?? "member"),
  });
  revalidatePath(`/project/${orgId}/${projectId}/members`);
}
