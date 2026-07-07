import Link from "next/link";
import { getOverview } from "@/lib/data";
import { PageHead, StatusPill, EmptyState } from "@/components/ui";
import { IconDecisions } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const o = await getOverview(orgId, projectId);
  const items = o?.decisions ?? [];
  const proposed = items.filter((d) => d.status === "proposed" || d.status === "open");
  const settled = items.filter((d) => d.status !== "proposed" && d.status !== "open");

  const reviewHref = (origin?: string) =>
    origin === "document" ? `/project/${orgId}/${projectId}/sources` : `/project/${orgId}/${projectId}/review-queue`;

  const Row = ({ d }: { d: (typeof items)[number] }) => (
    <div className="row" key={d.id}>
      <div className="body">
        <div className="title">{d.ruleText || d.scopeRef}</div>
        <div className="meta">
          <span className="code-ref">{d.scopeRef}</span>
          <span className="pill plain">{d.scopeKind}</span>
          {d.origin && d.origin !== "agent" && <span className="pill plain">{d.origin}</span>}
          <span>v{d.version}</span>
        </div>
      </div>
      {d.status === "proposed" || d.status === "open" ? (
        <Link className="btn ghost" href={reviewHref(d.origin)}>
          {d.origin === "document" ? "Ratify →" : "Review →"}
        </Link>
      ) : (
        <StatusPill status={d.status} />
      )}
    </div>
  );

  return (
    <>
      <PageHead title="Decisions" subtitle="Binding rules every agent must honor — versioned and attributed." />
      {items.length === 0 ? (
        <EmptyState icon={<IconDecisions />} title="No decisions yet">
          Agents record binding rules here via <span className="code-ref">propose_decision</span>.
        </EmptyState>
      ) : (
        <>
          {proposed.length > 0 && (
            <>
              <div className="section-title">Awaiting review ({proposed.length})</div>
              <div className="card animate-in" style={{ marginBottom: 18 }}>
                <div className="rows stagger">
                  {proposed.map((d) => (
                    <Row d={d} key={d.id} />
                  ))}
                </div>
              </div>
            </>
          )}
          <div className="section-title">Binding &amp; settled ({settled.length})</div>
          {settled.length === 0 ? (
            <EmptyState icon={<IconDecisions />} title="Nothing binding yet">
              Confirm or ratify the proposals above to make them binding.
            </EmptyState>
          ) : (
            <div className="card animate-in">
              <div className="rows stagger">
                {settled.map((d) => (
                  <Row d={d} key={d.id} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
