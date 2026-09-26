import { getOrgMe, getRoles } from "@/lib/org-data";
import { LoadError, PageHead } from "@/components/next/bits";
import { RolesTable } from "@/components/org/OrgPeople";

export const dynamic = "force-dynamic";

export default async function RolesPage({ params }: { params: { orgId: string } }) {
  const [roles, me] = await Promise.all([getRoles(params.orgId), getOrgMe(params.orgId)]);
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Roles" meta="Owners manage roles · admins publish and roll out · members draft and propose" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!roles ? (
          <LoadError what="roles" />
        ) : (
          <RolesTable orgId={params.orgId} rows={roles?.roles ?? []} canManage={me?.role === "owner"} />
        )}
      </div>
    </div>
  );
}
