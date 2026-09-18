import { notFound } from "next/navigation";
import { Target, ExternalLink, FileCode2 } from "lucide-react";
import { getFeature, constraintKindLabel, type ConstraintKind } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { StatGrid, Stat } from "@/components/StatGrid";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { confirmGovernsEdgeAction, rejectGovernsEdgeAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string; ref: string } }) {
  const { orgId, projectId, ref } = params;
  const feature = await getFeature(orgId, projectId, decodeURIComponent(ref));
  const base = `/project/${orgId}/${projectId}`;
  if (!feature) notFound();

  const { doc, coverage } = feature;
  const constraints = feature.constraints ?? [];
  const surfaces = feature.governedSurfaces ?? [];
  const governedConfirmed = surfaces.filter((s) => s.status === "confirmed").length;
  const hidden = (edgeId: string) => (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="edgeId" value={edgeId} />
    </>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Features", href: `${base}/features` }, { label: feature.label ?? feature.ref }]}
        title={feature.label ?? feature.ref}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <RefChip>{feature.ref}</RefChip>
            {doc && <StatusBadge status={doc.state} />}
            {doc?.title && <span>{doc.title}</span>}
          </div>
        }
        actions={
          doc?.url ? (
            <Button asChild size="sm" variant="ghost">
              <a href={doc.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Open PRD
              </a>
            </Button>
          ) : undefined
        }
      />

      <StatGrid>
        <Stat
          n={`${coverage.constraintsWithActivity}/${coverage.totalConstraints}`}
          label="Constraints with activity"
        />
        <Stat n={coverage.openConflicts} label="Open conflicts" href={`${base}/review-queue?tab=conflicts`} />
        <Stat n={governedConfirmed} label="Governed surfaces" />
        <Stat n={surfaces.length - governedConfirmed} label="Proposed links" hint="confirm below" />
      </StatGrid>

      <Section label="Constraints" count={constraints.length}>
        {constraints.length === 0 ? (
          <EmptyState icon={<Target />} title="No constraints yet">
            Constraints ratified against this capability appear here.
          </EmptyState>
        ) : (
          constraints.map((c) => (
            <ListRow
              key={c.id}
              href={`${base}/decisions/${c.id}`}
              title={c.ruleText}
              meta={
                <>
                  <RefChip>{c.scopeRef}</RefChip>
                  {c.constraintKind && (
                    <RefChip copy={false}>{constraintKindLabel(c.constraintKind as ConstraintKind)}</RefChip>
                  )}
                </>
              }
              status={<StatusBadge status={c.conflict ? "conflict" : c.status} origin="document" />}
              action={
                c.anchorUrl ? (
                  <Button asChild size="icon" variant="ghost" aria-label="View in PRD">
                    <a href={c.anchorUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </Section>

      <Section label="Governed surfaces" count={surfaces.length}>
        {surfaces.length === 0 ? (
          <EmptyState icon={<FileCode2 />} title="No governed surfaces yet">
            Surfaces this capability governs appear here as they are linked from the graph.
          </EmptyState>
        ) : (
          surfaces.map((s) => (
            <ListRow
              key={s.edgeId}
              leading={<FileCode2 />}
              title={<span className="font-mono text-sm">{s.surface}</span>}
              meta={
                <span>
                  {s.implementing.decisions} decision{s.implementing.decisions === 1 ? "" : "s"} ·{" "}
                  {s.implementing.changes} change
                  {s.implementing.changes === 1 ? "" : "s"}
                </span>
              }
              status={<StatusBadge status={s.status} />}
              action={
                s.status === "proposed" ? (
                  <>
                    <form action={confirmGovernsEdgeAction}>
                      {hidden(s.edgeId)}
                      <Button size="sm" variant="secondary">
                        Confirm
                      </Button>
                    </form>
                    <form action={rejectGovernsEdgeAction}>
                      {hidden(s.edgeId)}
                      <Button size="sm" variant="ghost">
                        Reject
                      </Button>
                    </form>
                  </>
                ) : undefined
              }
            />
          ))
        )}
      </Section>
    </>
  );
}
