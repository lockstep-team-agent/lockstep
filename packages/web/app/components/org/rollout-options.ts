import { apiGet } from "@/lib/api";
import type { OrgOverview } from "@/lib/types";
import { getCatalog, getRoles, getTeams } from "@/lib/org-data";
import type { Pickable } from "./RolloutForm";

const repoName = (remote: string) => remote.replace(/^[^/]+\//, "");

/** Everything the rollout form can pick from: published versions, projects, repos, teams, people. */
export async function rolloutOptions(orgId: string) {
  const [std, skill, check, org, teams, roles] = await Promise.all([
    getCatalog(orgId, "standard"),
    getCatalog(orgId, "skill"),
    getCatalog(orgId, "check"),
    apiGet<OrgOverview>(`/orgs/${orgId}/overview`),
    getTeams(orgId),
    getRoles(orgId),
  ]);
  const items: Pickable[] = [std, skill, check].flatMap((c) =>
    (c?.items ?? [])
      .filter((i) => i.published && !i.archived)
      .map((i) => ({
        itemId: i.id,
        versionId: i.published!.id,
        kind: i.kind,
        name: i.name,
        version: i.published!.version,
      })),
  );
  const live = (org?.projects ?? []).filter((p) => !p.archived);
  return {
    items,
    projects: live.map((p) => ({ id: p.id, label: p.name })),
    repos: live.flatMap((p) =>
      (p.repos ?? []).map((r) => ({ id: r.id, label: `${repoName(r.gitRemote)} · ${p.name}` })),
    ),
    teams: (teams?.teams ?? []).map((t) => ({ id: t.id, label: t.name })),
    people: (roles?.roles ?? []).map((r) => ({ id: r.memberId, label: r.login })),
    names: {
      project: new Map(live.map((p) => [p.id, p.name])),
      repo: new Map(live.flatMap((p) => (p.repos ?? []).map((r) => [r.id, repoName(r.gitRemote)] as const))),
      team: new Map((teams?.teams ?? []).map((t) => [t.id, t.name])),
      person: new Map((roles?.roles ?? []).map((r) => [r.memberId, r.login])),
    },
  };
}

type Names = Awaited<ReturnType<typeof rolloutOptions>>["names"];

/** "Org-wide · teams Platform · paths src/api/**" */
export function scopeLine(s: import("@/lib/org-data").SelectorsIn | null, names: Names): string {
  if (!s) return "—";
  const list = (ids: string[] | undefined, m: Map<string, string>) =>
    (ids ?? []).map((i) => m.get(i) ?? i.slice(0, 8)).join(", ");
  const parts = [
    s.projects?.length ? `projects ${list(s.projects, names.project)}` : "",
    s.repos?.length ? `repos ${list(s.repos, names.repo)}` : "",
    s.audience && s.audience.kind !== "all"
      ? `${s.audience.kind === "teams" ? "teams" : "people"} ${list(s.audience.ids, s.audience.kind === "teams" ? names.team : names.person)}`
      : "",
    s.taskTypes?.length ? `${s.taskTypes.join("/")} work` : "",
    s.pathGlobs?.length ? `paths ${s.pathGlobs.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Whole organization";
}
