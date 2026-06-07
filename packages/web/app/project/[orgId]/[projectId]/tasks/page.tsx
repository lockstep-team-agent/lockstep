import { getOverview } from "@/lib/data";
import { PageHead, StatusPill, EmptyState } from "@/components/ui";
import { IconTasks } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.tasks ?? [];
  return (
    <>
      <PageHead title="Tasks" subtitle="Work delegated between agents — queued for the receiving human to approve." />
      {items.length === 0 ? (
        <EmptyState icon={<IconTasks />} title="No tasks yet">
          Agents hand off work via <span className="code-ref">delegate</span>; it queues for approval here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {items.map((t) => (
              <div className="row" key={t.id}>
                <div className="body">
                  <div className="title">{t.title}</div>
                  <div className="meta">
                    <span className={`pill ${t.runState}`}>{t.runState}</span>
                  </div>
                </div>
                <StatusPill status={t.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
