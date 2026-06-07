import { getOverview } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconDependencies, IconArrow } from "@/components/icons";
import { DependencyGraph } from "@/components/Graph";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const deps = o?.dependencies ?? [];
  const repos = o?.repos ?? [];
  const repoName = new Map(repos.map((r) => [r.id, r.gitRemote.split("/").pop() ?? r.gitRemote]));

  return (
    <>
      <PageHead title="Dependencies" subtitle="Which services consume which surfaces — this is what routes a change to the right teammate." />
      {deps.length === 0 ? (
        <EmptyState icon={<IconDependencies />} title="No dependencies yet">
          When an agent codes against another service's surface, it records the edge via{" "}
          <span className="code-ref">register_dependency</span>.
        </EmptyState>
      ) : (
        <>
          <DependencyGraph repos={repos} dependencies={deps} />
          <div className="section-title">All edges</div>
          <div className="card animate-in">
            <div className="rows stagger">
              {deps.map((d) => (
                <div className="row" key={d.id}>
                  <div className="body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="code-ref">{repoName.get(d.consumerRepoId) ?? "consumer"}</span>
                    <IconArrow style={{ width: 15, height: 15, color: "var(--dim)" }} />
                    <span className="mono" style={{ color: "var(--violet)" }}>{d.producedSurface}</span>
                  </div>
                  <span className="pill plain">{d.source}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
