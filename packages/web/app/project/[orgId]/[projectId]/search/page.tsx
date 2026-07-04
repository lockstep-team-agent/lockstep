import { searchDecisions } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { IconDecisions } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { q?: string; status?: string; origin?: string };
}) {
  const { orgId, projectId } = params;
  const q = searchParams.q ?? "";
  const status = searchParams.status ?? "";
  const origin = searchParams.origin ?? "";
  const qs =
    "?" +
    new URLSearchParams(
      Object.entries({ q, status, origin }).filter(([, v]) => v) as [string, string][],
    ).toString();
  const data = await searchDecisions(orgId, projectId, qs === "?" ? "" : qs);
  const items = data?.decisions ?? [];

  return (
    <>
      <PageHead title="Search decisions" subtitle="Ask what the team decided — answered from the ledger, with provenance." />

      <form method="get" className="card animate-in" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input name="q" defaultValue={q} placeholder="what did we decide about…" className="input" style={{ flex: 1, minWidth: 220 }} />
          <select name="status" defaultValue={status} className="input">
            <option value="">any status</option>
            <option value="binding">binding</option>
            <option value="open">open</option>
            <option value="proposed">proposed</option>
            <option value="superseded">superseded</option>
          </select>
          <select name="origin" defaultValue={origin} className="input">
            <option value="">any origin</option>
            <option value="agent">agent</option>
            <option value="ingested">ingested</option>
          </select>
          <button className="btn primary">Search</button>
        </div>
      </form>

      {items.length === 0 ? (
        <EmptyState icon={<IconDecisions />} title={q ? "No matches" : "Search the decision ledger"}>
          Try a topic, a rule keyword, a surface, or a source quote.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {items.map((d) => {
              const url = d.provenance?.url;
              return (
                <div className="row" key={d.id}>
                  <div className="body">
                    <div className="title">{d.ruleText || d.scopeRef}</div>
                    <div className="meta">
                      <span className="code-ref">{d.scopeRef}</span>
                      <span className="pill plain">{d.scopeKind}</span>
                      <span className="pill plain">{d.origin}</span>
                      {d.provenance?.source && <span>via {d.provenance.source}</span>}
                      {url && (
                        <a href={url} target="_blank" rel="noreferrer" className="code-ref">source ↗</a>
                      )}
                    </div>
                  </div>
                  <StatusPill status={d.status} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
