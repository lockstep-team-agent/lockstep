import { apiGet } from "@/lib/api";
import { getOverview } from "@/lib/data";
import { PageHead } from "@/components/ui";
import { IconRepo } from "@/components/icons";
import { inviteAction, connectRepoAction } from "@/actions";
import type { OrgOverview } from "@/lib/types";

export const dynamic = "force-dynamic";

const preStyle = {
  background: "var(--surface-2)",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-sm)",
  padding: "12px 14px",
  fontSize: 12.5,
  color: "var(--muted)",
  whiteSpace: "pre-wrap" as const,
  overflowX: "auto" as const,
  lineHeight: 1.7,
};

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const org = await apiGet<OrgOverview>(`/orgs/${orgId}/overview`);
  const o = await getOverview(orgId, projectId);
  const members = org?.members ?? [];
  const repos = o?.repos ?? [];
  const projectName = org?.projects.find((p) => p.id === projectId)?.name ?? "project";
  const api = process.env.LOCKSTEP_API_URL ?? "https://your-core";

  return (
    <>
      <PageHead title="Members & Repos" subtitle="People in this project, connected repos, and how to onboard more." />

      <div className="section-title">Members</div>
      <div className="card animate-in">
        <div className="rows stagger">
          {members.map((m) => (
            <div className="row" key={m.id}>
              <span className="avatar" style={{ width: 24, height: 24, borderRadius: 8, fontSize: 10 }}>
                {(m.githubLogin[0] ?? "?").toUpperCase()}
              </span>
              <div className="body">
                <div className="title">@{m.githubLogin}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <form className="inline" action={inviteAction} style={{ marginTop: 12 }}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input className="input" name="githubLogin" placeholder="github-handle" style={{ maxWidth: 240 }} />
        <button className="btn primary" type="submit">
          Invite teammate
        </button>
      </form>

      <div className="section-title">Connected repos</div>
      <div className="card animate-in">
        <div className="rows stagger">
          {repos.length === 0 ? (
            <div className="row">
              <span style={{ color: "var(--dim)" }}>No repos connected yet.</span>
            </div>
          ) : (
            repos.map((r) => (
              <div className="row" key={r.id}>
                <IconRepo style={{ width: 18, height: 18, color: "var(--dim)" }} />
                <div className="body">
                  <div className="title mono">{r.gitRemote}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <form className="inline" action={connectRepoAction} style={{ marginTop: 12 }}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input className="input mono" name="gitRemote" placeholder="github.com/org/repo" style={{ maxWidth: 320 }} />
        <button className="btn" type="submit">
          Connect repo
        </button>
      </form>

      <div className="section-title">Onboard a teammate</div>
      <div className="card pad animate-in">
        <p style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 10 }}>
          Have them run, from inside their repo:
        </p>
        <pre className="mono" style={preStyle}>{`npm i -g lockstep-cli
lockstep login --api ${api}
lockstep init
lockstep connect --project "${projectName}"`}</pre>
      </div>
    </>
  );
}
