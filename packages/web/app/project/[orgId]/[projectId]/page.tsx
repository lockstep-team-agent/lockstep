import Link from "next/link";
import { getOverview, timeAgo, humanizeAction } from "@/lib/data";
import { PageHead, Stat, StatusPill, EmptyState } from "@/components/ui";
import { IconDecisions, IconQuestions, IconTasks, IconDependencies, IconActivity } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Overview({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const base = `/project/${params.orgId}/${params.projectId}`;
  if (!o) return <EmptyState icon={<IconActivity />} title="Couldn't load this project" />;

  const binding = o.decisions.filter((d) => d.status === "binding").length;
  const openQ = o.questions.filter((q) => q.status !== "closed").length;
  const activeT = o.tasks.filter((t) => t.status !== "closed").length;

  return (
    <>
      <PageHead title="Overview" subtitle="Your team's shared record at a glance." />

      <div className="stats stagger">
        <Stat n={binding} label="Binding decisions" icon={<IconDecisions />} />
        <Stat n={openQ} label="Open questions" icon={<IconQuestions />} />
        <Stat n={activeT} label="Active tasks" icon={<IconTasks />} />
        <Stat n={o.dependencies.length} label="Dependencies" icon={<IconDependencies />} />
      </div>

      <div className="section-title">Recent activity</div>
      <div className="card animate-in">
        {o.audit.length === 0 ? (
          <div className="rows"><div className="row"><span className="muted" style={{ color: "var(--dim)" }}>No activity yet — make a change in a connected repo.</span></div></div>
        ) : (
          <div className="rows">
            {o.audit.slice(0, 8).map((a, i) => (
              <div className="row" key={i}>
                <span className="avatar" style={{ width: 22, height: 22, borderRadius: 7, fontSize: 10 }}>
                  <IconActivity style={{ width: 12, height: 12, color: "#08110f" }} />
                </span>
                <div className="body">
                  <div className="title" style={{ fontSize: 13.5 }}>{humanizeAction(a.action)}</div>
                  <div className="meta">
                    {a.entityKind && <span className="code-ref">{a.entityKind}</span>}
                    <span>{timeAgo(a.createdAt)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-title">Latest decisions</div>
      <div className="card animate-in">
        {o.decisions.length === 0 ? (
          <div className="rows"><div className="row"><Link href={`${base}/decisions`} style={{ color: "var(--teal)" }}>No decisions yet →</Link></div></div>
        ) : (
          <div className="rows">
            {o.decisions.slice(0, 5).map((d) => (
              <div className="row" key={d.id}>
                <div className="body">
                  <div className="title">{d.ruleText || d.scopeRef}</div>
                  <div className="meta">
                    <span className="code-ref">{d.scopeRef}</span>
                    <span>v{d.version}</span>
                  </div>
                </div>
                <StatusPill status={d.status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
