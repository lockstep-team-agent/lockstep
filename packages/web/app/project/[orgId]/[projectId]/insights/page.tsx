import { getInsights } from "@/lib/data";
import { PageHead, Stat, EmptyState } from "@/components/ui";
import { IconActivity, IconOverview } from "@/components/icons";

export const dynamic = "force-dynamic";

const pct = (rate: number) => Math.round(rate * 100) + "%";

export default async function Insights({ params }: { params: { orgId: string; projectId: string } }) {
  const i = await getInsights(params.orgId, params.projectId);
  if (!i) return <EmptyState icon={<IconActivity />} title="Couldn't load insights" />;

  return (
    <>
      <PageHead
        title="Insights"
        subtitle="Tuning signals for extraction confidence, ratification, and conflict handling."
      />

      <div className="stats stagger">
        <Stat
          n={pct(i.ratification.rate)}
          label={`Ratification approval · ${i.ratification.ratified}/${i.ratification.ratified + i.ratification.rejected}`}
          icon={<IconOverview />}
        />
        <Stat
          n={pct(i.conflicts.rate)}
          label={`Conflict dismiss rate · ${i.conflicts.dismissed}/${i.conflicts.resolved}`}
          icon={<IconActivity />}
        />
        <Stat
          n={pct(i.lowConfidence.rate)}
          label={`Low-confidence accepted · ${i.lowConfidence.accepted}/${i.lowConfidence.total}`}
          icon={<IconActivity />}
        />
        <Stat
          n={pct(i.anchors.rate)}
          label={`Anchor validity · ${i.anchors.valid}/${i.anchors.total}`}
          icon={<IconOverview />}
        />
      </div>

      <div className="section-title">Dismiss reasons</div>
      <div className="card animate-in">
        {i.conflicts.dismissReasons.length === 0 ? (
          <EmptyState icon={<IconActivity />} title="No dismissed conflicts yet">
            When a co-location conflict is dismissed, its reason shows up here.
          </EmptyState>
        ) : (
          <div className="rows">
            {i.conflicts.dismissReasons.map((r) => (
              <div className="row" key={r.reason}>
                <div className="body">
                  <div className="title" style={{ fontSize: 13.5 }}>
                    {r.reason}
                  </div>
                </div>
                <span className="code-ref">{r.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
