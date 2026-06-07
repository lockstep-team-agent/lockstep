import { getOverview } from "@/lib/data";
import { PageHead, StatusPill, EmptyState } from "@/components/ui";
import { IconDecisions } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.decisions ?? [];
  return (
    <>
      <PageHead title="Decisions" subtitle="Binding rules every agent must honor — versioned and attributed." />
      {items.length === 0 ? (
        <EmptyState icon={<IconDecisions />} title="No decisions yet">
          Agents record binding rules here via <span className="code-ref">propose_decision</span>.
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
                    <span className="pill plain">{d.scopeKind}</span>
                    <span>v{d.version}</span>
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
