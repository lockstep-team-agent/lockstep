import { getOverview } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconContracts } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams?: { q?: string; repo?: string };
}) {
  const o = await getOverview(params.orgId, params.projectId);
  const all = o?.contracts ?? [];
  const repos = o?.repos ?? [];
  const repoName = new Map(repos.map((r) => [r.id, r.gitRemote.split("/").pop() ?? r.gitRemote]));

  const q = (searchParams?.q ?? "").trim().toLowerCase();
  const repoFilter = searchParams?.repo ?? "";
  const items = all
    .filter((c) => (repoFilter ? c.repoId === repoFilter : true))
    .filter((c) => (q ? c.surface.toLowerCase().includes(q) : true))
    .sort((a, b) => a.surface.localeCompare(b.surface));

  // group by repo
  const byRepo = new Map<string, typeof items>();
  for (const c of items) {
    const arr = byRepo.get(c.repoId) ?? [];
    arr.push(c);
    byRepo.set(c.repoId, arr);
  }

  return (
    <>
      <PageHead
        title="Contracts"
        subtitle="Interface surfaces across your repos — extracted from source. Search or filter by repo."
      />

      {all.length > 0 && (
        <form method="get" className="card pad animate-in" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              name="q"
              defaultValue={searchParams?.q ?? ""}
              placeholder="search surface e.g. /auth or POST"
              className="input"
              style={{ flex: 1, minWidth: 220 }}
            />
            <select name="repo" defaultValue={repoFilter} className="input" style={{ maxWidth: 220 }}>
              <option value="">all repos</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {repoName.get(r.id)}
                </option>
              ))}
            </select>
            <button className="btn">Filter</button>
          </div>
          <p style={{ color: "var(--dim)", fontSize: 12.5, margin: "8px 0 0" }}>
            {items.length} of {all.length} surfaces
          </p>
        </form>
      )}

      {all.length === 0 ? (
        <EmptyState icon={<IconContracts />} title="No contracts captured yet">
          When an agent changes an API surface, the contract delta appears here.
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon={<IconContracts />} title="No matches">
          Nothing matches your search — clear it to see all {all.length} surfaces.
        </EmptyState>
      ) : (
        [...byRepo.entries()].map(([repoId, list]) => (
          <div key={repoId} style={{ marginBottom: 18 }}>
            <div className="section-title">
              {repoName.get(repoId) ?? "repo"} ({list.length})
            </div>
            <div className="card animate-in">
              <div className="rows">
                {list.map((c) => {
                  const m = /^http:(\w+)\s/.exec(c.surface)?.[1];
                  return (
                    <div className="row" key={c.id}>
                      <div className="body">
                        <div className="title mono">{c.surface}</div>
                        <div className="meta">
                          {m && <span className="pill plain">{m}</span>}
                          <span>v{c.version}</span>
                        </div>
                      </div>
                      <span className={`pill ${c.verified ? "verified" : "unverified"}`}>
                        {c.verified ? "verified" : "asserted"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))
      )}
    </>
  );
}
