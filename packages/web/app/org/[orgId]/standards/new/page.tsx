import type { Kind } from "@/lib/org-data";
import { PageHead } from "@/components/next/bits";
import { ItemEditor } from "@/components/org/ItemEditor";
import { pinOptions, requirementOptions } from "@/components/org/pin-options";

export const dynamic = "force-dynamic";

const KINDS: Kind[] = ["standard", "skill", "check"];

export default async function NewItemPage({
  params,
  searchParams,
}: {
  params: { orgId: string };
  searchParams: { kind?: string };
}) {
  const kind = KINDS.find((k) => k === searchParams.kind) ?? "standard";
  const opts = kind === "standard" ? await pinOptions(params.orgId) : { skills: [], checks: [] };
  const reqOpts = kind === "check" ? await requirementOptions(params.orgId) : [];
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title={`New ${kind}`}
        meta="Saved as a draft — nothing reaches anyone until it's published and assigned"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="max-w-3xl">
          <ItemEditor
            orgId={params.orgId}
            kind={kind}
            initialContent={{}}
            canPublish={false}
            skillOptions={opts.skills}
            checkOptions={opts.checks}
            requirementOptions={reqOpts}
          />
        </div>
      </div>
    </div>
  );
}
