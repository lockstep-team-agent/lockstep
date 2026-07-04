import { searchDecisions } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { IconActivity } from "@/components/icons";
import { timeAgo } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * Human blast-radius view: decisions with org-wide reach (impact > 0) — the ones a person on an
 * affected team should know about. Cross-cutting decisions are also fanned out to agents' inboxes on
 * confirm; this is the human-facing side of the same signal.
 */
export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const data = await searchDecisions(orgId, projectId, "");
  const items = (data?.decisions ?? [])
    .filter((d) => d.impact > 0 && d.status !== "rejected" && d.status !== "proposed")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <>
      <PageHead
        title="Notifications"
        subtitle="Decisions with a blast radius — cross-cutting rules that affect more than the area they came from."
      />
      {items.length === 0 ? (
        <EmptyState icon={<IconActivity />} title="Nothing high-impact yet">
          When a decision affects a surface others consume — or a topic several people work on — it shows up here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {items.map((d) => (
              <div className="row" key={d.id}>
                <div className="body">
                  <div className="title">{d.ruleText || d.scopeRef}</div>
                  <div className="meta">
                    <span className="code-ref">{d.scopeRef}</span>
                    <span className="pill plain">impact {d.impact}</span>
                    {d.provenance?.source && <span>via {d.provenance.source}</span>}
                    <span>{timeAgo(d.createdAt)}</span>
                  </div>
                </div>
                <StatusPill status={d.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
