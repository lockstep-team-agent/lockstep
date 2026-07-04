import Link from "next/link";
import { getFeatures } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconFeature } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const data = await getFeatures(orgId, projectId);
  const features = data?.features ?? [];
  const base = `/project/${orgId}/${projectId}`;

  return (
    <>
      <PageHead
        title="Features"
        subtitle="Product capabilities and how the build reconciles against their ratified constraints."
      />

      {features.length === 0 ? (
        <EmptyState icon={<IconFeature />} title="No features yet">
          No features yet — capabilities appear here once a capability-scoped constraint is ratified from a PRD.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {features.map((f) => (
              <div className="row" key={f.ref}>
                <IconFeature style={{ width: 18, height: 18, color: "var(--dim)", marginTop: 2 }} />
                <div className="body">
                  <div className="title">
                    <Link href={`${base}/features/${encodeURIComponent(f.ref)}`}>{f.label ?? f.ref}</Link>
                  </div>
                  <div className="meta">
                    <span>
                      {f.constraintCounts.binding}/{f.constraintCounts.total} binding
                    </span>
                    <span>
                      {f.governedSurfaces.confirmed} governed
                      {f.governedSurfaces.proposed > 0 && (
                        <span style={{ color: "var(--dim)" }}> +{f.governedSurfaces.proposed} proposed</span>
                      )}
                    </span>
                  </div>
                </div>
                {f.openConflicts > 0 && (
                  <span className="pill urgent">
                    {f.openConflicts} conflict{f.openConflicts === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
