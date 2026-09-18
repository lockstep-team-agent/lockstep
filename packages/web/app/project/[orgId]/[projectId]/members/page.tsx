import { FolderGit2, ShieldCheck } from "lucide-react";
import { apiGet } from "@/lib/api";
import { getOverview, getGithubInstall } from "@/lib/data";
import type { OrgOverview } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  inviteAction,
  connectRepoAction,
  updateMemberRoleAction,
  setVisibilityAction,
  setArchivedAction,
  disconnectRepoAction,
  setMemberSlackAction,
} from "@/actions";

export const dynamic = "force-dynamic";

const ROLES = ["member", "pm", "owner"] as const;

const Initial = ({ login }: { login: string }) => (
  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary">
    {(login[0] ?? "?").toUpperCase()}
  </span>
);
const selectCls = "h-8 rounded-md border bg-card px-2 text-sm";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const [org, o, ghInstall] = await Promise.all([
    apiGet<OrgOverview>(`/orgs/${orgId}/overview`),
    getOverview(orgId, projectId),
    getGithubInstall(orgId),
  ]);
  const orgMembers = org?.members ?? [];
  const projectMembers = o?.members;
  const isOwner = o?.viewer?.role === "owner";
  const canAdminRepos = isOwner || o?.viewer?.role === "pm";
  const visibility = o?.visibility ?? "shared";
  const archived = o?.archived ?? false;
  const repos = o?.repos ?? [];
  const projectName = org?.projects.find((p) => p.id === projectId)?.name ?? "project";
  const api = process.env.LOCKSTEP_API_URL ?? "https://your-core";
  const appSlug = process.env.GITHUB_APP_SLUG;
  const installUrl = appSlug
    ? `https://github.com/apps/${appSlug}/installations/new?state=${orgId}:${projectId}`
    : null;

  const ids = (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
    </>
  );

  return (
    <>
      <PageHeader
        title="Members & Repos"
        description="People in this project, connected repos, and how to onboard more."
      />

      <Section label="Members" count={projectMembers?.length ?? orgMembers.length}>
        {projectMembers
          ? projectMembers.map((m) => (
              <ListRow
                key={m.id}
                leading={<Initial login={m.githubLogin} />}
                title={`@${m.githubLogin}`}
                meta={
                  <>
                    <StatusBadge status={m.status} />
                    <RefChip copy={false}>{m.role}</RefChip>
                    {m.slackUserId ? <span>Slack linked</span> : <span>No Slack</span>}
                  </>
                }
                action={
                  <>
                    {m.memberId && (
                      <form action={setMemberSlackAction} className="flex items-center gap-1">
                        {ids}
                        <input type="hidden" name="memberId" value={m.memberId} />
                        <Input
                          name="slackUserId"
                          defaultValue={m.slackUserId ?? ""}
                          placeholder="U01ABC…"
                          className="h-8 w-32 font-mono text-xs"
                          aria-label="Slack user id"
                        />
                        <Button size="sm" variant="secondary">
                          Link
                        </Button>
                      </form>
                    )}
                    {isOwner && (
                      <form action={updateMemberRoleAction} className="flex items-center gap-1">
                        {ids}
                        <input type="hidden" name="projectMemberId" value={m.id} />
                        <select name="role" defaultValue={m.role} className={selectCls} aria-label="Role">
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <Button size="sm" variant="secondary">
                          Update
                        </Button>
                      </form>
                    )}
                  </>
                }
              />
            ))
          : orgMembers.map((m) => (
              <ListRow key={m.id} leading={<Initial login={m.githubLogin} />} title={`@${m.githubLogin}`} />
            ))}
        <div className="border-t p-4">
          <form action={inviteAction} className="flex flex-wrap items-center gap-2">
            {ids}
            <Input
              name="githubLogin"
              placeholder="github-handle"
              className="w-60"
              aria-label="GitHub handle"
              required
            />
            <select
              name="role"
              defaultValue="member"
              className="h-9 rounded-md border bg-card px-3 text-sm"
              aria-label="Role"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button>Invite teammate</Button>
          </form>
        </div>
      </Section>

      <Section label="Connected repos" count={repos.length}>
        {repos.length === 0 ? (
          <EmptyState icon={<FolderGit2 />} title="No repos connected yet">
            Connect a repo below, or run <RefChip copy={false}>lockstep connect</RefChip> from inside it.
          </EmptyState>
        ) : (
          repos.map((r) => (
            <ListRow
              key={r.id}
              leading={<FolderGit2 />}
              title={<span className="font-mono text-sm">{r.gitRemote}</span>}
              action={
                canAdminRepos ? (
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="ghost">
                        Disconnect
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Disconnect this repo?</DialogTitle>
                        <DialogDescription>
                          Removes the repo and its contracts from the graph. History is retained; reconnect any time.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <form action={disconnectRepoAction}>
                          {ids}
                          <input type="hidden" name="repoId" value={r.id} />
                          <Button variant="destructive">Disconnect</Button>
                        </form>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                ) : undefined
              }
            />
          ))
        )}
        <div className="border-t p-4">
          <form action={connectRepoAction} className="flex flex-wrap items-center gap-2">
            {ids}
            <Input
              name="gitRemote"
              placeholder="github.com/org/repo"
              className="w-80 font-mono"
              aria-label="Git remote"
              required
            />
            <Button variant="secondary">Connect repo</Button>
          </form>
        </div>
      </Section>

      <Section label="Onboard a teammate" bare>
        <Card className="shadow-none">
          <CardContent className="p-4 text-sm">
            <p className="mb-3 text-muted-foreground">Have them run, from inside their repo:</p>
            <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs leading-relaxed text-muted-foreground">
              {`npm i -g lockstep-cli\nlockstep login --api ${api}\nlockstep onboard --project "${projectName}"`}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              <RefChip copy={false}>onboard</RefChip> wires the repo for their agent (hooks, MCP, skills) and links it
              to this project in one step.
            </p>
          </CardContent>
        </Card>
      </Section>

      <Section label="GitHub App" bare>
        <Card className="shadow-none">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <div>
                <div className="font-medium">Repos and CODEOWNERS are read through a GitHub App</div>
                <div className="text-muted-foreground">Scoped and revocable, never a personal token.</div>
              </div>
            </div>
            {ghInstall?.installed ? (
              <div className="flex items-center gap-2">
                <StatusBadge status="active" />
                <span className="text-muted-foreground">
                  Installed{ghInstall.accountLogin ? ` on ${ghInstall.accountLogin}` : ""}
                </span>
                {installUrl && (
                  <Button asChild size="sm" variant="ghost">
                    <a href={installUrl} target="_blank" rel="noreferrer">
                      Manage
                    </a>
                  </Button>
                )}
              </div>
            ) : installUrl ? (
              <Button asChild size="sm" variant="secondary">
                <a href={installUrl} target="_blank" rel="noreferrer">
                  Install GitHub App
                </a>
              </Button>
            ) : (
              <span
                className="text-muted-foreground"
                title={
                  isOwner ? "Set GITHUB_APP_SLUG on the dashboard service to enable one-click install." : undefined
                }
              >
                Ask an admin to enable the GitHub App.
              </span>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section label="Visibility" bare>
        <Card className="shadow-none">
          <CardContent className="grid gap-3 p-4 text-sm">
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Shared</span> — any member of the org can read this project.{" "}
              <span className="font-medium text-foreground">Walled</span> — only project members can read its decisions,
              graph, and surfaces. Walling an existing project? Invite everyone who should keep access first.
            </p>
            <form action={setVisibilityAction} className="flex flex-wrap items-center gap-2">
              {ids}
              <select
                name="visibility"
                defaultValue={visibility}
                disabled={!isOwner}
                className="h-9 rounded-md border bg-card px-3 text-sm"
                aria-label="Visibility"
              >
                <option value="shared">Shared with org</option>
                <option value="walled">Walled — members only</option>
              </select>
              <Button
                variant="secondary"
                disabled={!isOwner}
                title={isOwner ? undefined : "Only project owners can change visibility"}
              >
                Update visibility
              </Button>
            </form>
          </CardContent>
        </Card>
      </Section>

      <Section label="Archive" bare>
        <Card className="shadow-none">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <p className="max-w-2xl text-muted-foreground">
              {archived
                ? "This project is archived: hidden from the workspace list, no new sessions, no sweeps or digests. Everything is retained."
                : "Archiving makes the project inert: hidden from the workspace list, connect and join blocked, no sweeps or digests. Nothing is deleted."}
            </p>
            {isOwner ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" variant={archived ? "secondary" : "destructive"}>
                    {archived ? "Unarchive project" : "Archive project"}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{archived ? "Unarchive this project?" : "Archive this project?"}</DialogTitle>
                    <DialogDescription>
                      {archived
                        ? "Sessions, sweeps, and digests resume."
                        : "Agents lose access to new sessions until it is unarchived. Nothing is deleted."}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <form action={setArchivedAction}>
                      {ids}
                      <input type="hidden" name="archived" value={archived ? "false" : "true"} />
                      <Button variant={archived ? "secondary" : "destructive"}>
                        {archived ? "Unarchive" : "Archive"}
                      </Button>
                    </form>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : (
              <span className="text-xs text-muted-foreground">Only project owners can archive.</span>
            )}
          </CardContent>
        </Card>
      </Section>
    </>
  );
}
