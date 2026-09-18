import { Waypoints } from "lucide-react";
import { getGraph } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { deriveGraphAction, addGraphEdgeAction } from "@/actions";

export const dynamic = "force-dynamic";

const KIND_ORDER = ["project", "team", "topic", "surface", "capability", "doc", "person"];

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const g = await getGraph(orgId, projectId);
  const nodes = g?.nodes ?? [];
  const edges = g?.edges ?? [];
  const base = `/project/${orgId}/${projectId}`;
  const label = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? `${n.kind}:${n.label ?? n.ref}` : id.slice(0, 8);
  };
  const byKind = KIND_ORDER.map((k) => ({ kind: k, items: nodes.filter((n) => n.kind === k) })).filter(
    (x) => x.items.length,
  );
  const selectCls = "h-9 min-w-48 rounded-md border bg-card px-3 text-sm";

  return (
    <>
      <PageHeader
        title="Org graph"
        description="Teams, topics, surfaces and people — this is what gives non-code decisions a blast radius."
        actions={
          <form action={deriveGraphAction}>
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="projectId" value={projectId} />
            <Button variant={nodes.length === 0 ? "default" : "secondary"} size="sm">
              Derive from members & decisions
            </Button>
          </form>
        }
      />

      {nodes.length === 0 ? (
        <EmptyState icon={<Waypoints />} title="Graph is empty">
          Derive it to auto-build nodes from your team and the decisions distilled so far, then correct edges below.
        </EmptyState>
      ) : (
        <>
          <Section label="Nodes" count={nodes.length}>
            {byKind.map((grp) => (
              <ListRow
                key={grp.kind}
                title={<span className="capitalize">{grp.kind}</span>}
                extra={
                  <span className="flex flex-wrap gap-1.5">
                    {grp.items.map((n) =>
                      n.kind === "capability" ? (
                        <RefChip key={n.id} href={`${base}/features/${encodeURIComponent(n.ref)}`}>
                          {n.label ?? n.ref}
                        </RefChip>
                      ) : (
                        <RefChip key={n.id} copy={false}>
                          {n.label ?? n.ref}
                        </RefChip>
                      ),
                    )}
                  </span>
                }
                status={<RefChip copy={false}>{String(grp.items.length)}</RefChip>}
              />
            ))}
          </Section>

          <Section label="Edges" count={edges.length}>
            {edges.slice(0, 100).map((e, i) => (
              <ListRow
                key={i}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2 text-sm">
                    <RefChip copy={false}>{label(e.fromId)}</RefChip>
                    <span className="text-muted-foreground">—{e.kind}→</span>
                    <RefChip copy={false}>{label(e.toId)}</RefChip>
                  </span>
                }
                status={e.kind === "governs" && e.status === "proposed" ? <StatusBadge status="proposed" /> : undefined}
              />
            ))}
          </Section>

          <Section label="Add or correct an edge" bare>
            <Card className="shadow-none">
              <CardContent className="p-4">
                <form action={addGraphEdgeAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <select name="fromId" className={selectCls} required aria-label="From node">
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.kind}: {n.label ?? n.ref}
                      </option>
                    ))}
                  </select>
                  <select name="toId" className={selectCls} required aria-label="To node">
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.kind}: {n.label ?? n.ref}
                      </option>
                    ))}
                  </select>
                  <Input name="kind" placeholder="relates" className="w-40" aria-label="Edge kind" />
                  <Button variant="secondary">Add edge</Button>
                </form>
              </CardContent>
            </Card>
          </Section>
        </>
      )}
    </>
  );
}
