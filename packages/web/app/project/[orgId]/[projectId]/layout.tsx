import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { Nav } from "@/components/Nav";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { IconLogout } from "@/components/icons";
import { logoutAction } from "@/actions";
import type { Me, OrgOverview, ProjectOverview } from "@/lib/types";

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

  const org = await apiGet<OrgOverview>(`/orgs/${orgId}/overview`);
  const o = await apiGet<ProjectOverview>(`/orgs/${orgId}/projects/${projectId}/overview`);
  const projectName = org?.projects.find((p) => p.id === projectId)?.name ?? "project";
  const base = `/project/${orgId}/${projectId}`;
  const counts = {
    decisions: o?.decisions.length,
    questions: o?.questions.filter((q) => q.status !== "closed").length,
    tasks: o?.tasks.filter((t) => t.status !== "closed").length,
    contracts: o?.contracts.length,
    dependencies: o?.dependencies.length,
  };
  const initial = (me.principal.githubLogin[0] ?? "?").toUpperCase();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" /> Lockstep
        </div>
        <div className="switcher">
          <div className="lbl">Project</div>
          <ProjectSwitcher orgId={orgId} projectId={projectId} projects={org?.projects ?? []} />
        </div>
        <Nav base={base} counts={counts} />
        <div className="sidebar-foot">
          <form action={logoutAction}>
            <button className="nav-item" style={{ width: "100%", border: "none", background: "transparent", textAlign: "left" }}>
              <IconLogout /> Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{projectName}</h1>
          <div className="spacer" />
          <div className="who">
            <span>{me.principal.githubLogin}</span>
            <span className="avatar">{initial}</span>
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
