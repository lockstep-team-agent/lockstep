import { getOrgMe, getRoles, getTeams } from "@/lib/org-data";
import { LoadError, PageHead } from "@/components/next/bits";
import { TeamsManager } from "@/components/org/OrgPeople";

export const dynamic = "force-dynamic";

export default async function TeamsPage({ params }: { params: { orgId: string } }) {
  const [teams, roles, me] = await Promise.all([
    getTeams(params.orgId),
    getRoles(params.orgId),
    getOrgMe(params.orgId),
  ]);
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Teams" meta="Audiences for assignments — managed by owners and admins" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!teams ? (
          <LoadError what="teams" />
        ) : (
          <TeamsManager
            orgId={params.orgId}
            teams={teams?.teams ?? []}
            people={roles?.roles ?? []}
            canManage={me?.role === "owner" || me?.role === "admin"}
          />
        )}
      </div>
    </div>
  );
}
