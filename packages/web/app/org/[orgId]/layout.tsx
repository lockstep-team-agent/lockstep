import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { Me, OrgOverview } from "@/lib/types";
import { getOrgMe, standardsEnabled } from "@/lib/org-data";
import { newUiEnabled } from "@/lib/next-data";
import { logoutAction } from "@/actions";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { UserMenu } from "@/components/shell/UserMenu";
import { ThemeToggle } from "@/components/next/ThemeToggle";
import { OrgNav } from "@/components/org/OrgNav";

export const dynamic = "force-dynamic";

/**
 * The Organization context: org-level Standards & Skills (and, later, Rollouts). Clearly labelled;
 * it aggregates org metadata only — project artifacts still need project access.
 */
export default async function OrgLayout({ children, params }: { children: ReactNode; params: { orgId: string } }) {
  if (!standardsEnabled() || !newUiEnabled()) notFound();
  const me = await apiGet<Me>("/me");
  if (!me) redirect("/");
  const [org, orgMe] = await Promise.all([
    apiGet<OrgOverview>(`/orgs/${params.orgId}/overview`),
    getOrgMe(params.orgId),
  ]);
  if (!org || !orgMe) notFound();
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[232px] shrink-0 flex-col border-r">
        <div className="flex h-12 items-center gap-2 px-3">
          <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] bg-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">Lockstep</span>
        </div>
        <div className="px-2 pb-2 [&_button]:h-8 [&_button]:text-[13px]">
          <ProjectSwitcher orgId={params.orgId} projectId="__org__" projects={org.projects} withOrg orgName={org.org?.name} />
        </div>
        <div className="mx-2 mb-3 rounded-md border border-dashed px-2 py-1.5 text-[11px] leading-4 text-faint">
          {org.org?.name ?? "Organization"} —{" "}
          {orgMe.role ? `you are an org ${orgMe.role}` : "you can draft and propose; admins publish"}.
        </div>
        <OrgNav orgId={params.orgId} admin={orgMe.role === "owner" || orgMe.role === "admin"} />
        <div className="mt-auto flex items-center gap-1 border-t px-2 py-2">
          <UserMenu login={me.principal.githubLogin} role={orgMe.role ?? "member"} onSignOut={logoutAction} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">@{me.principal.githubLogin}</span>
          <ThemeToggle />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="shell-page">{children}</div>
      </main>
    </div>
  );
}
