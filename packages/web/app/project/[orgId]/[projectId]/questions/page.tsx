import { getOverview } from "@/lib/data";
import { PageHead, StatusPill, EmptyState } from "@/components/ui";
import { IconQuestions } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.questions ?? [];
  return (
    <>
      <PageHead title="Questions" subtitle="Code & repo questions, routed to owners and answered into the ledger." />
      {items.length === 0 ? (
        <EmptyState icon={<IconQuestions />} title="No open questions">
          Agents ask code/repo questions via <span className="code-ref">ask</span>; answers are written back here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {items.map((q) => (
              <div className="row" key={q.id}>
                <div className="body">
                  <div className="title">{q.body}</div>
                  <div className="meta">
                    {q.scopeRef && <span className="code-ref">{q.scopeRef}</span>}
                    {q.urgent && <span className="pill urgent">urgent</span>}
                  </div>
                </div>
                <StatusPill status={q.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
