import { PageHead } from "@/components/next/bits";
import { ImportWizard } from "@/components/org/ImportWizard";

export default function ImportPage({ params }: { params: { orgId: string } }) {
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Import a skill from GitHub" meta="Captured at an exact commit, verified, never run" />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ImportWizard orgId={params.orgId} />
      </div>
    </div>
  );
}
