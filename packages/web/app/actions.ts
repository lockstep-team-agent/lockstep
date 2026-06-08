"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiPost } from "./lib/api";

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
  await apiPost(`/orgs/${orgId}/projects/${projectId}/invite`, {
    githubLogin: String(formData.get("githubLogin") ?? ""),
  });
  revalidatePath(`/project/${orgId}/${projectId}`);
}
