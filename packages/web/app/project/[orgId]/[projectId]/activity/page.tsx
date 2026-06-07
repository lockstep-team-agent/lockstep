import { getOverview, timeAgo, humanizeAction } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconActivity } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.audit ?? [];
  return (
    <>
      <PageHead title="Activity" subtitle="Immutable audit trail — who decided, acked, changed, or delegated what." />
      {items.length === 0 ? (
        <EmptyState icon={<IconActivity />} title="No activity yet" />
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {items.map((a, i) => (
              <div className="row" key={i}>
                <span className="avatar" style={{ width: 22, height: 22, borderRadius: 7 }}>
                  <IconActivity style={{ width: 12, height: 12, color: "#08110f" }} />
                </span>
                <div className="body">
                  <div className="title" style={{ fontSize: 13.5 }}>{humanizeAction(a.action)}</div>
                  <div className="meta">{a.entityKind && <span className="code-ref">{a.entityKind}</span>}</div>
                </div>
                <span style={{ color: "var(--dim)", fontSize: 12 }}>{timeAgo(a.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
