import { getGraph } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconDependencies } from "@/components/icons";
import { deriveGraphAction, addGraphEdgeAction } from "@/actions";

export const dynamic = "force-dynamic";

const KIND_ORDER = ["project", "team", "topic", "surface", "doc", "person"];

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const g = await getGraph(orgId, projectId);
  const nodes = g?.nodes ?? [];
  const edges = g?.edges ?? [];
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? `${n.kind}:${n.label ?? n.ref}` : id.slice(0, 8);
  };
  const byKind = KIND_ORDER.map((k) => ({ kind: k, items: nodes.filter((n) => n.kind === k) })).filter((x) => x.items.length);

  return (
    <>
      <PageHead
        title="Org graph"
        subtitle="Teams, topics, surfaces and people — this is what gives non-code decisions a blast radius."
      />

      <form action={deriveGraphAction} style={{ marginBottom: 16 }}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="projectId" value={projectId} />
        <button className="btn primary">Derive from members &amp; decisions</button>
      </form>

      {nodes.length === 0 ? (
        <EmptyState icon={<IconDependencies />} title="Graph is empty">
          Click “Derive” to auto-build nodes from your team and the decisions distilled so far.
        </EmptyState>
      ) : (
        <>
          <div className="card animate-in" style={{ marginBottom: 16 }}>
            <div className="rows">
              {byKind.map((grp) => (
                <div className="row" key={grp.kind}>
                  <div className="body">
                    <div className="title" style={{ textTransform: "capitalize" }}>{grp.kind}</div>
                    <div className="meta" style={{ flexWrap: "wrap", gap: 6 }}>
                      {grp.items.map((n) => (
                        <span key={n.id} className="pill plain">{n.label ?? n.ref}</span>
                      ))}
                    </div>
                  </div>
                  <span className="pill plain">{grp.items.length}</span>
                </div>
              ))}
            </div>
          </div>

          <PageHead title="Edges" subtitle={`${edges.length} connection(s)`} />
          <div className="card animate-in" style={{ marginBottom: 16 }}>
            <div className="rows stagger">
              {edges.slice(0, 100).map((e, i) => (
                <div className="row" key={i}>
                  <div className="body">
                    <div className="meta">
                      <span className="code-ref">{label(e.fromId)}</span>
                      <span>—{e.kind}→</span>
                      <span className="code-ref">{label(e.toId)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <form action={addGraphEdgeAction} className="card animate-in" style={{ padding: 16 }}>
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="projectId" value={projectId} />
            <div className="title" style={{ marginBottom: 8 }}>Add / correct an edge</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select name="fromId" className="input" required>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.kind}: {n.label ?? n.ref}</option>
                ))}
              </select>
              <select name="toId" className="input" required>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.kind}: {n.label ?? n.ref}</option>
                ))}
              </select>
              <input name="kind" placeholder="relates" className="input" />
              <button className="btn primary">Add edge</button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
