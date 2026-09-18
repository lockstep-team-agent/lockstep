import { Target } from "lucide-react";
import { getFeatures } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const data = await getFeatures(orgId, projectId);
  const features = data?.features ?? [];
  const base = `/project/${orgId}/${projectId}`;

  return (
    <>
      <PageHeader
        title="Features"
        description="Product capabilities and how the build reconciles against their ratified constraints."
      />
      {features.length === 0 ? (
        <EmptyState icon={<Target />} title="No features yet">
          Capabilities appear here once a capability-scoped constraint is ratified from a PRD.
        </EmptyState>
      ) : (
        <Section label="Capabilities" count={features.length}>
          {features.map((f) => (
            <ListRow
              key={f.ref}
              href={`${base}/features/${encodeURIComponent(f.ref)}`}
              leading={<Target />}
              title={f.label ?? f.ref}
              meta={
                <>
                  <RefChip copy={false}>{f.ref}</RefChip>
                  <span>
                    {f.constraintCounts.binding}/{f.constraintCounts.total} binding
                  </span>
                  <span>
                    {f.governedSurfaces.confirmed} governed
                    {f.governedSurfaces.proposed > 0 && ` · ${f.governedSurfaces.proposed} proposed`}
                  </span>
                  {f.docTitle && <span>{f.docTitle}</span>}
                </>
              }
              status={f.openConflicts > 0 ? <StatusBadge status="conflict" /> : undefined}
            />
          ))}
        </Section>
      )}
    </>
  );
}
