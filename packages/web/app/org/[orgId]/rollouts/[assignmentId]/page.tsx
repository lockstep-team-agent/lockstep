import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdoption, getAssignments, getOrgMe, type EnvState } from "@/lib/org-data";
import { btn, Empty, PageHead } from "@/components/next/bits";
import { When } from "@/components/When";
import { ChangeButton, WithdrawControl } from "@/components/org/RolloutPreview";
import { rolloutOptions, scopeLine } from "@/components/org/rollout-options";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const h = "mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";
const STATE: Record<EnvState, { label: string; tone: string }> = {
  installed: { label: "Installed", tone: "text-primary-ink" },
  outdated: { label: "Outdated", tone: "text-foreground" },
  pending_sync: { label: "Pending sync", tone: "text-faint" },
  failed: { label: "Failed", tone: "text-destructive" },
  user_action_required: { label: "Needs user action", tone: "text-destructive" },
  declined: { label: "Declined", tone: "text-faint" },
  exempt: { label: "Exempt", tone: "text-faint" },
  unsupported: { label: "Unsupported", tone: "text-faint" },
  blocked: { label: "Blocked", tone: "text-destructive" },
  offered: { label: "Offered", tone: "text-faint" },
};

export default async function RolloutDetail({ params }: { params: { orgId: string; assignmentId: string } }) {
  const { orgId, assignmentId } = params;
  const [ad, list, me, opts] = await Promise.all([
    getAdoption(orgId, assignmentId),
    getAssignments(orgId),
    getOrgMe(orgId),
    rolloutOptions(orgId),
  ]);
  if (me && !me.role) return <Empty title="Rollouts are visible to org owners and admins" hint="Your own checkouts and their skills are under My environments." />;
  if (!ad) notFound();
  const admin = me?.role === "owner" || me?.role === "admin";
  const live = ad.assignment.state !== "retired";
  const cur = ad.revisions.find((r) => r.revision === ad.assignment.revision);
  const versionName = new Map(opts.items.map((i) => [i.versionId, `${i.name} v${i.version}`]));
  const i = ad.installation;
  const col = "rounded-md border px-3 py-2.5";
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title={ad.assignment.name}
        meta={`rev ${ad.assignment.revision} · ${cur?.level ?? ""}${cur?.pilot ? " · pilot" : ""} · ${ad.assignment.state} · ${scopeLine(cur?.selectors ?? null, opts.names)}`}
        actions={
          admin && live ? (
            <Link href={`/org/${orgId}/rollouts/${assignmentId}/edit`} className={btn.outline}>
              Change versions or scope
            </Link>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <section aria-label="Adoption" className="grid gap-3 md:grid-cols-5">
          <div className={col}>
            <div className={h}>Coverage</div>
            <div className="text-[20px] font-semibold tabular-nums">{ad.coverage.enrolledEnvironments}</div>
            <div className="text-[12px] text-muted-foreground">
              enrolled checkouts where it applies · {ad.coverage.coveredMembers} people
            </div>
            {ad.coverage.membersNotEnrolled > 0 && (
              <div className="mt-1 text-[12px] text-faint">
                {ad.coverage.membersNotEnrolled} of {ad.coverage.reachableMembers} people in scope have no enrolled checkout where it applies
              </div>
            )}
            {ad.coverage.guidanceEnvironments > 0 && (
              <div className="mt-1 text-[12px] text-faint">{ad.coverage.guidanceEnvironments} receive its standards as guidance</div>
            )}
          </div>
          <div className={col}>
            <div className={h}>Installation</div>
            <div className="text-[20px] font-semibold tabular-nums">{i.installed}</div>
            <div className="text-[12px] text-muted-foreground">at the assigned version, seen in the last 7 days</div>
            <div className="mt-1 text-[12px] text-faint">
              {[
                i.stale && `${i.stale} last seen installed (no contact 7d+)`,
                i.outdated && `${i.outdated} outdated`,
                i.pending_sync && `${i.pending_sync} pending`,
                i.failed && `${i.failed} failed`,
                i.user_action_required && `${i.user_action_required} need action`,
                i.declined && `${i.declined} declined`,
                i.blocked && `${i.blocked} blocked`,
                i.unsupported && `${i.unsupported} unsupported`,
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </div>
          </div>
          <div className={col}>
            <div className={h}>In sessions</div>
            <div className="text-[20px] font-semibold tabular-nums">{ad.sessionAvailability.available}</div>
            <div className="text-[12px] text-muted-foreground">
              of {ad.sessionAvailability.installed} installed seen at a session start
            </div>
          </div>
          <div className={col}>
            <div className={h}>Invocation</div>
            <div className="text-[12px] text-muted-foreground">{ad.invocation}</div>
          </div>
          <div className={col}>
            <div className={h}>Outcomes</div>
            {ad.outcomes.results === 0 ? (
              <div className="text-[12px] text-muted-foreground">No check has run under this release yet.</div>
            ) : (
              <>
                <div className="text-[20px] font-semibold tabular-nums">{ad.outcomes.possibleIssues}</div>
                <div className="text-[12px] text-muted-foreground">possible issues across {ad.outcomes.results} results</div>
                <div className="mt-1 text-[12px] text-faint">
                  {ad.outcomes.completed} completed · {ad.outcomes.notEvaluated} not evaluated
                  {ad.outcomes.exempt ? ` · ${ad.outcomes.exempt} exempt` : ""}
                </div>
              </>
            )}
          </div>
        </section>

        {ad.troubleshooting.length > 0 && (
          <section>
            <h2 className={h}>Troubleshooting</h2>
            <ul className="space-y-1 text-[12px]">
              {ad.troubleshooting.map((t) => (
                <li key={t.code}>
                  <span className="font-mono">{t.code}</span> — {t.environments} environment
                  {t.environments === 1 ? "" : "s"}
                  {t.code === "local_edits" && " (someone edited the managed copy; they choose restore or keep)"}
                  {t.code === "integrity" && " (download didn't match its hash; existing files kept)"}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className={h}>Environments</h2>
          {ad.rows.length === 0 ? (
            <p className="text-[13px] text-faint">
              No enrolled environment is in scope yet. People enroll a checkout with{" "}
              <code className="font-mono text-[12px]">lockstep enroll</code>.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[12px]">
                <thead className="text-left text-[11px] text-faint">
                  <tr className="border-b">
                    <th className="px-3 py-1.5 font-medium">Person</th>
                    <th className="px-3 py-1.5 font-medium">Checkout</th>
                    <th className="px-3 py-1.5 font-medium">Adapter</th>
                    <th className="px-3 py-1.5 font-medium">Skills</th>
                    <th className="px-3 py-1.5 text-right font-medium">Last contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ad.rows.map((r) => (
                    <tr key={r.envId}>
                      <td className="px-3 py-1.5">{r.login}</td>
                      <td className="max-w-[220px] truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {r.repo ?? "workspace"}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.adapter}</td>
                      <td className="px-3 py-1.5">
                        {r.skills.map((s) => (
                          <span key={s.itemId} className="mr-3 whitespace-nowrap">
                            {s.name}
                            {s.version ? ` v${s.version}` : ""}:{" "}
                            <span className={s.fresh ? STATE[s.state].tone : "text-faint"}>
                              {s.fresh ? STATE[s.state].label : `Last seen ${STATE[s.state].label.toLowerCase()}`}
                            </span>
                            {s.sessionAvailable && <span className="text-faint"> · in session</span>}
                          </span>
                        ))}
                        {r.guidance.length > 0 && (
                          <span className="whitespace-nowrap text-faint">
                            guidance: {r.guidance.map((g) => `${g.name} v${g.version}`).join(", ")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <When at={r.lastContactAt} className="text-faint" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {ad.truncated && (
            <p className="mt-1 text-[11px] text-faint">Showing the first {ad.rows.length} environments.</p>
          )}
        </section>

        <section>
          <h2 className={h}>History</h2>
          <ol className="space-y-3">
            {ad.revisions.map((r) => (
              <li
                key={r.revision}
                className={cn(
                  "rounded-md border px-3 py-2.5",
                  r.revision === ad.assignment.revision && live && "border-border-strong",
                )}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="font-medium">rev {r.revision}</span>
                  <span className="text-faint">
                    {r.reason} · {r.level}
                    {r.pilot && " · pilot"}
                  </span>
                  {r.revision === ad.assignment.revision && live && <span className="text-primary-ink">current</span>}
                  {r.release?.withdrawn && <span className="text-destructive">release withdrawn</span>}
                  <When at={r.createdAt} className="ml-auto text-[11px] text-faint" />
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  {r.release?.name}:{" "}
                  {(r.release?.items ?? [])
                    .map((x) => versionName.get(x.versionId) ?? `${x.kind} (older version)`)
                    .join(" · ")}
                </div>
                <div className="text-[12px] text-faint">{scopeLine(r.selectors, opts.names)}</div>
                {admin && live && r.revision !== ad.assignment.revision && (
                  <div className="mt-2">
                    <ChangeButton
                      orgId={orgId}
                      change={{ kind: "rollback", assignmentId, toRevision: r.revision }}
                      label={`Roll back to rev ${r.revision}`}
                      confirm="Apply rollback"
                      variant="ghost"
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        {admin && live && (
          <section className="grid gap-6 border-t pt-4 md:grid-cols-2">
            <div>
              <h2 className={h}>Retire</h2>
              <p className="mb-2 text-[12px] text-muted-foreground">
                Stops this rollout. Skills are removed at each checkout’s next sync unless another rollout still needs
                them.
              </p>
              <ChangeButton
                orgId={orgId}
                change={{ kind: "retire", assignmentId }}
                label="Preview retirement"
                confirm="Retire rollout"
                variant="danger"
              />
            </div>
            {cur?.release && !cur.release.withdrawn && (
              <div>
                <h2 className={h}>Withdraw release “{cur.release.name}”</h2>
                <p className="mb-2 text-[12px] text-muted-foreground">
                  For a release that must never be used again — it’s excluded from every rollout that references it.
                  Offline machines update when they next connect.
                </p>
                <WithdrawControl
                  orgId={orgId}
                  releaseId={cur.release.id}
                  others={(list?.releases ?? [])
                    .filter((x) => x.id !== cur.release!.id && !x.withdrawn)
                    .map((x) => ({ id: x.id, name: x.name }))}
                />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
