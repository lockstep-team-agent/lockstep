import { getMyEnvironments, type EnvState } from "@/lib/org-data";
import { Empty, LoadError, PageHead } from "@/components/next/bits";
import { When } from "@/components/When";
import { rolloutOptions } from "@/components/org/rollout-options";

export const dynamic = "force-dynamic";

const LABEL: Partial<Record<EnvState, string>> = {
  installed: "installed",
  outdated: "outdated — syncs at next session start",
  pending_sync: "pending — syncs at next session start",
  failed: "failed — existing files kept",
  user_action_required: "edited locally — run lockstep skills restore/keep",
  unsupported: "this adapter can't install skills",
};

export default async function MyEnvironments({ params }: { params: { orgId: string } }) {
  const [data, o] = await Promise.all([getMyEnvironments(params.orgId), rolloutOptions(params.orgId)]);
  const envs = data?.environments ?? [];
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="My environments" meta="Your enrolled checkouts and the org skills they hold" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!data ? (
          <LoadError what="your environments" />
        ) : envs.length === 0 ? (
          <Empty
            title="No enrolled checkouts"
            hint={
              <>
                Run <code className="font-mono">lockstep enroll</code> in a connected repository to receive your
                organization’s skills.
              </>
            }
          />
        ) : (
          <ul className="divide-y">
            {envs.map((e) => (
              <li key={e.id} className="px-5 py-3">
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="font-medium">{(e.repoId && o.names.repo.get(e.repoId)) || "Workspace"}</span>
                  <span className="text-[12px] text-faint">
                    {e.adapter}
                    {e.adapterVersion ? ` ${e.adapterVersion}` : ""}
                  </span>
                  <span className="ml-auto text-[11px] text-faint">
                    last contact <When at={e.lastContactAt} />
                  </span>
                </div>
                <ul className="mt-1.5 space-y-0.5 text-[12px]">
                  {e.skills.map((s) => (
                    <li key={s.itemId}>
                      {s.name} v{s.version} <span className="text-faint">({s.level})</span> —{" "}
                      {LABEL[s.state] ?? s.state}
                      {s.sessionAvailable && <span className="text-faint"> · used by a session</span>}
                    </li>
                  ))}
                  {e.offered.map((s) => (
                    <li key={s.slug} className="text-muted-foreground">
                      {s.name} v{s.version} — recommended;{" "}
                      <code className="font-mono text-[11px]">lockstep skills accept {s.slug}</code>
                    </li>
                  ))}
                  {e.declined.map((s) => (
                    <li key={s.slug} className="text-faint">
                      {s.name} — declined here;{" "}
                      <code className="font-mono text-[11px]">lockstep skills accept {s.slug}</code> to take it back
                    </li>
                  ))}
                  {e.blocked.map((b) => (
                    <li key={b.name} className="text-destructive">
                      {b.name} — assigned at v{b.versions.join(" and v")}; waiting for an admin to resolve
                    </li>
                  ))}
                  {!e.skills.length && !e.offered.length && !e.declined.length && !e.blocked.length && (
                    <li className="text-faint">No org skills assigned here.</li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
