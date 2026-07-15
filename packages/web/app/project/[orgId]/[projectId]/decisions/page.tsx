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

  // ruleText lookup for lineage links — "superseded by →" shows the successor's rule, not a bare id.
  const byId = new Map(items.map((d) => [d.id, d]));
  const lineageLabel = (id: string) => byId.get(id)?.ruleText || byId.get(id)?.scopeRef || "another decision";

  const Row = ({ d }: { d: (typeof items)[number] }) => (
    <div className="row" key={d.id} id={d.id}>
      <div className="body">
        <div className="title">{d.ruleText || d.scopeRef}</div>
        {d.rationale && <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>{d.rationale}</p>}
        <div className="meta">
          <span className="code-ref">{d.scopeRef}</span>
          <span className="pill plain">{d.scopeKind}</span>
          {d.decisionType === "principle" && <span className="pill plain">principle</span>}
          {d.origin && d.origin !== "agent" && <span className="pill plain">{d.origin}</span>}
          <span>v{d.version}</span>
          {d.dueForReview && <span className="pill conflict">due for review</span>}
        </div>
        {d.alternatives && d.alternatives.length > 0 && (
          <details className="collapse" style={{ marginTop: 6 }}>
            <summary>Alternatives considered ({d.alternatives.length})</summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--muted)", fontSize: 13 }}>
              {d.alternatives.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        )}
        {(d.supersededById || (d.supersedes && d.supersedes.length > 0)) && (
          <div className="meta" style={{ marginTop: 4 }}>
            {d.supersededById && (
              <a href={`#${d.supersededById}`}>superseded by → “{lineageLabel(d.supersededById)}”</a>
            )}
            {d.supersedes?.map((id) => (
              <a key={id} href={`#${id}`}>
                supersedes → “{lineageLabel(id)}”
              </a>
            ))}
          </div>
        )}
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
