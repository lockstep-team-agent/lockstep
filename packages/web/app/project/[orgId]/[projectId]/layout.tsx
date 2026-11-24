import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { Me, OrgOverview } from "@/lib/types";
import { Shell } from "@/components/next/Shell";
import { getInbox } from "@/lib/next-data";
import { standardsEnabled } from "@/lib/org-data";

export const dynamic = "force-dynamic";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { orgId: string; projectId: string };
}) {
  const { orgId, projectId } = params;
  const me = await apiGet<Me>("/me");
  if (!me) redirect("/");

  const [org, inbox] = await Promise.all([
    apiGet<OrgOverview>(`/orgs/${orgId}/overview`),
    getInbox(orgId, projectId),
  ]);
  return (
    <Shell
      orgId={orgId}
      projectId={projectId}
      projects={org?.projects ?? []}
      login={me.principal.githubLogin}
      role={inbox?.viewer.role ?? "member"}
      withOrg={standardsEnabled()}
      orgName={org?.org?.name}
    >
      {children}
    </Shell>
  );
}
