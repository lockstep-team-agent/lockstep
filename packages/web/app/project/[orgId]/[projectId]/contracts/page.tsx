import { getOverview } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconContracts } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.contracts ?? [];
  const repoName = new Map((o?.repos ?? []).map((r) => [r.id, r.gitRemote.split("/").pop() ?? r.gitRemote]));
  return (
    <>
      <PageHead title="Contracts" subtitle="Interface deltas published by agents — verified locally against real code where possible." />
      {items.length === 0 ? (
        <EmptyState icon={<IconContracts />} title="No contracts captured yet">
          When an agent changes an API surface, the verified contract delta appears here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {items.map((c) => (
              <div className="row" key={c.id}>
                <div className="body">
                  <div className="title mono">{c.surface}</div>
                  <div className="meta">
                    <span className="code-ref">{repoName.get(c.repoId) ?? "repo"}</span>
                    <span>v{c.version}</span>
                  </div>
                </div>
                <span className={`pill ${c.verified ? "verified" : "unverified"}`}>
                  {c.verified ? "verified" : "asserted"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
