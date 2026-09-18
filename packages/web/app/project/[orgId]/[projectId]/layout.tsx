import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { getCounts, getOverview } from "@/lib/data";
import type { Me, OrgOverview } from "@/lib/types";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { Hotkey } from "@/components/shell/Hotkey";

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

  const [org, o, projectCounts] = await Promise.all([
    apiGet<OrgOverview>(`/orgs/${orgId}/overview`),
    getOverview(orgId, projectId),
    getCounts(orgId, projectId),
  ]);
  const base = `/project/${orgId}/${projectId}`;
  const projectName = org?.projects.find((p) => p.id === projectId)?.name ?? "project";
  const counts = {
    review: projectCounts?.review.total ?? 0,
    decisions: o?.decisions.filter((d) => d.status !== "rejected" && d.status !== "superseded").length,
    questions: o?.questions.filter((q) => q.status !== "closed").length,
    tasks: o?.tasks.filter((t) => t.status !== "closed" && t.status !== "done").length,
    contracts: o?.contracts.length,
    dependencies: o?.dependencies.length,
    sources: projectCounts?.sources,
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar orgId={orgId} projectId={projectId} projects={org?.projects ?? []} base={base} counts={counts} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          base={base}
          orgName="Workspace"
          projectName={projectName}
          login={me.principal.githubLogin}
          role={o?.viewer?.role ?? "member"}
          reviewCount={counts.review}
          counts={counts}
        />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 lg:px-6">
          <Hotkey />
          {children}
        </main>
      </div>
    </div>
  );
}
