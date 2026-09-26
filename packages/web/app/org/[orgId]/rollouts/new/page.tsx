import { PageHead } from "@/components/next/bits";
import { RolloutForm } from "@/components/org/RolloutForm";
import { rolloutOptions } from "@/components/org/rollout-options";

export const dynamic = "force-dynamic";

export default async function NewRolloutPage({
  params,
  searchParams,
}: {
  params: { orgId: string };
  searchParams: { version?: string };
}) {
  const o = await rolloutOptions(params.orgId);
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="New rollout" meta="Preview the impact, then start it — nothing changes until you do" />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <RolloutForm
          orgId={params.orgId}
          items={o.items}
          projects={o.projects}
          repos={o.repos}
          teams={o.teams}
          people={o.people}
          initial={{ versionIds: searchParams.version ? [searchParams.version] : [] }}
        />
      </div>
    </div>
  );
}
