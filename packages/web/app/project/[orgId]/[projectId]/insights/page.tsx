import { Gauge } from "lucide-react";
import { getInsights } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { StatGrid, Stat } from "@/components/StatGrid";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

export default async function Insights({ params }: { params: { orgId: string; projectId: string } }) {
  const i = await getInsights(params.orgId, params.projectId);
  if (!i) return <EmptyState icon={<Gauge />} title="Couldn't load insights" />;

  const denominators =
    i.ratification.ratified + i.ratification.rejected + i.conflicts.resolved + i.lowConfidence.total + i.anchors.total;

  return (
    <>
      <PageHeader
        title="Insights"
        description="Tuning signals for extraction confidence, ratification, and conflict handling."
      />

      {denominators === 0 ? (
        <div className="mb-6">
          <EmptyState icon={<Gauge />} title="No tuning signals yet">
            Rates appear once constraints have been ratified or rejected, conflicts resolved, and anchors verified.
          </EmptyState>
        </div>
      ) : (
        <StatGrid>
          <Stat
            n={pct(i.ratification.rate)}
            label="Ratification approval"
            hint={`${i.ratification.ratified}/${i.ratification.ratified + i.ratification.rejected}`}
          />
          <Stat
            n={pct(i.conflicts.rate)}
            label="Conflict dismiss rate"
            hint={`${i.conflicts.dismissed}/${i.conflicts.resolved}`}
          />
          <Stat
            n={pct(i.lowConfidence.rate)}
            label="Low-confidence accepted"
            hint={`${i.lowConfidence.accepted}/${i.lowConfidence.total}`}
          />
          <Stat n={pct(i.anchors.rate)} label="Anchor validity" hint={`${i.anchors.valid}/${i.anchors.total}`} />
        </StatGrid>
      )}

      <Section label="Dismiss reasons" count={i.conflicts.dismissReasons.length}>
        {i.conflicts.dismissReasons.length === 0 ? (
          <EmptyState icon={<Gauge />} title="No dismissed conflicts yet">
            When a co-location conflict is dismissed, its reason shows up here so extraction can be tuned.
          </EmptyState>
        ) : (
          i.conflicts.dismissReasons.map((r) => (
            <ListRow key={r.reason} title={r.reason} status={<RefChip copy={false}>{String(r.count)}</RefChip>} />
          ))
        )}
      </Section>
    </>
  );
}
