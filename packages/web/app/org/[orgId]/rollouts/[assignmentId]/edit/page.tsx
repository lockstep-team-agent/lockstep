import { notFound } from "next/navigation";
import { getAdoption } from "@/lib/org-data";
import { PageHead } from "@/components/next/bits";
import { RolloutForm } from "@/components/org/RolloutForm";
import { rolloutOptions } from "@/components/org/rollout-options";

export const dynamic = "force-dynamic";

export default async function EditRollout({ params }: { params: { orgId: string; assignmentId: string } }) {
  const [ad, o] = await Promise.all([getAdoption(params.orgId, params.assignmentId), rolloutOptions(params.orgId)]);
  if (!ad) notFound();
  const cur = ad.revisions.find((r) => r.revision === ad.assignment.revision);
  // Start from the current versions, moved to each item's latest published version.
  const latest = new Map(o.items.map((i) => [i.itemId, i.versionId]));
  const versionIds = (cur?.release?.items ?? [])
    .map((x) => latest.get(x.itemId) ?? x.versionId)
    .filter((v) => o.items.some((i) => i.versionId === v));
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title={`Revise “${ad.assignment.name}”`}
        meta={`Creates rev ${ad.assignment.revision + 1}; history is kept and you can roll back`}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <RolloutForm
          orgId={params.orgId}
          assignmentId={params.assignmentId}
          items={o.items}
          projects={o.projects}
          repos={o.repos}
          teams={o.teams}
          people={o.people}
          initial={{
            versionIds,
            level: (cur?.level as "required") ?? "required",
            selectors: cur?.selectors,
            pilot: cur?.pilot,
          }}
        />
      </div>
    </div>
  );
}
