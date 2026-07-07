import { apiGet } from "@/lib/api";
import { getOverview, getGithubInstall } from "@/lib/data";
import { PageHead, StatusPill } from "@/components/ui";
import { IconRepo } from "@/components/icons";
import {
  inviteAction,
  connectRepoAction,
  updateMemberRoleAction,
  setVisibilityAction,
  setMemberSlackAction,
} from "@/actions";
import type { OrgOverview } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES = ["member", "pm", "owner"] as const;

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
  const projectMembers = o?.members;
  const isOwner = o?.viewer?.role === "owner";
  const visibility = o?.visibility ?? "shared";
  const repos = o?.repos ?? [];
  const projectName = org?.projects.find((p) => p.id === projectId)?.name ?? "project";
  const api = process.env.LOCKSTEP_API_URL ?? "https://your-core";
  const ghInstall = await getGithubInstall(orgId);
  const appSlug = process.env.GITHUB_APP_SLUG;
  const installUrl = appSlug
    ? `https://github.com/apps/${appSlug}/installations/new?state=${orgId}:${projectId}`
    : null;

  return (
    <>
      <PageHead title="Members & Repos" subtitle="People in this project, connected repos, and how to onboard more." />

      <div className="section-title">GitHub App</div>
      <div className="card pad animate-in">
        <p style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 10 }}>
          Lockstep reads repos and CODEOWNERS through a GitHub App you install on your org — scoped and revocable, never
          a personal token.
        </p>
        {ghInstall?.installed ? (
          <div className="inline">
            <StatusPill status="active" />
            <span style={{ color: "var(--muted)" }}>
              Installed{ghInstall.accountLogin ? ` on ${ghInstall.accountLogin}` : ""}.
            </span>
            {installUrl && (
              <a className="btn ghost" href={installUrl} target="_blank" rel="noreferrer">
                Manage / add repos ↗
              </a>
            )}
          </div>
        ) : installUrl ? (
          <a className="btn primary" href={installUrl} target="_blank" rel="noreferrer">
            Install GitHub App ↗
          </a>
        ) : (
          <span style={{ color: "var(--dim)" }}>Set GITHUB_APP_SLUG to enable one-click install.</span>
        )}
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>
        Visibility
      </div>
      <div className="card pad animate-in">
        <p style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 10 }}>
          <strong>Shared</strong> — any member of the org can read this project. <strong>Walled</strong> — only the
          people listed below (project members) can read its decisions, graph, and surfaces. Walling an existing
          project? Invite everyone who should keep access first.
        </p>
        <form className="inline" action={setVisibilityAction}>
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="projectId" value={projectId} />
          <select
            name="visibility"
            className="input"
            defaultValue={visibility}
            disabled={!isOwner}
            style={{ maxWidth: 160 }}
          >
            <option value="shared">Shared with org</option>
            <option value="walled">Walled — members only</option>
          </select>
          {isOwner ? (
            <button className="btn">Update visibility</button>
          ) : (
            <span className="tip" data-tip="Only project owners can change visibility">
              <button className="btn" disabled>
                Update visibility
              </button>
            </span>
          )}
        </form>
      </div>

      <div className="section-title">Members</div>
      <div className="card animate-in">
        <div className="rows stagger">
          {projectMembers
            ? projectMembers.map((m) => (
                <div className="row" key={m.id}>
                  <span className="avatar" style={{ width: 24, height: 24, borderRadius: 8, fontSize: 10 }}>
                    {(m.githubLogin[0] ?? "?").toUpperCase()}
                  </span>
                  <div className="body">
                    <div className="title">@{m.githubLogin}</div>
                    <div className="meta">
                      <StatusPill status={m.status} />
                      {m.slackUserId ? (
                        <span className="pill" style={{ marginLeft: 6 }}>
                          Slack linked
                        </span>
                      ) : (
                        <span className="pill" style={{ marginLeft: 6, color: "var(--dim)" }}>
                          No Slack
                        </span>
                      )}
                    </div>
                  </div>
                  {m.memberId ? (
                    <form className="inline" action={setMemberSlackAction}>
                      <input type="hidden" name="orgId" value={orgId} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="memberId" value={m.memberId} />
                      <input
                        className="input mono"
                        name="slackUserId"
                        defaultValue={m.slackUserId ?? ""}
                        placeholder="U01ABC…"
                        style={{ maxWidth: 130 }}
                      />
                      <button className="btn">Link Slack</button>
                    </form>
                  ) : null}
                  <form className="inline" action={updateMemberRoleAction}>
                    <input type="hidden" name="orgId" value={orgId} />
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="projectMemberId" value={m.id} />
                    <select
                      name="role"
                      className="input"
                      defaultValue={m.role}
                      disabled={!isOwner}
                      style={{ maxWidth: 120 }}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {isOwner ? (
                      <button className="btn">Update role</button>
                    ) : (
                      <span className="tip" data-tip="Only project owners can change roles">
                        <button className="btn" disabled>
                          Update role
                        </button>
                      </span>
                    )}
                  </form>
                </div>
              ))
            : members.map((m) => (
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
        <select name="role" className="input" defaultValue="member" style={{ maxWidth: 120 }}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
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
