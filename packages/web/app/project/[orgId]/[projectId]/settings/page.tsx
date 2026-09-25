import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getConceptSettings, getOutline, newUiEnabled } from "@/lib/next-data";
import { DomainsEditor, HttpRulesEditor, RebuildButton } from "@/components/next/SettingsControls";
import { When } from "@/components/When";
import { Empty, PageHead } from "@/components/next/bits";

export const dynamic = "force-dynamic";

const ADMIN = [
  ["connections", "Connections", "Slack, Notion, Jira, Confluence and what Lockstep may read"],
  ["members", "Members & repos", "People, roles and connected repositories"],
  ["activity", "Activity", "The immutable audit trail"],
] as const;

export default async function SettingsPage({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  if (!newUiEnabled()) redirect(base);
  const [s, outline] = await Promise.all([getConceptSettings(orgId, projectId), getOutline(orgId, projectId)]);
  if (!s) return <Empty title="Couldn’t load settings" />;
  const ids = { orgId, projectId };
  const canEdit = ["owner", "pm"].includes(outline?.viewer.role ?? "member");
  const noProvider = !s.providers.jev && !s.providers.claude;
  const rb = s.rebuild;
  const running = rb.queued || (rb.phase !== null && rb.phase !== "done");

  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-10 px-6 py-8">
          {(noProvider || s.queue.noProvider > 0) && (
            <div
              role="status"
              className="rail rail-drift rounded-md border border-warning-edge py-3 pl-4 pr-4 text-[13px]"
            >
              <div className="font-medium">No classifier is configured</div>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Surfaces are still grouped by rule, but concept domains and non-surface decisions can’t be suggested
                {s.queue.noProvider > 0 && <> ({s.queue.noProvider} waiting)</>}. Set{" "}
                <code className="font-mono">TYPESAFE_API_KEY</code> or{" "}
                <code className="font-mono">ANTHROPIC_API_KEY</code> on the API; waiting work resumes on its own.
              </p>
            </div>
          )}

          <section>
            <div className="mb-3 flex items-end gap-3">
              <div className="flex-1">
                <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Domains</h2>
                <p className="text-[12px] text-faint">
                  The top level of the map. Concepts are filed into these; a human choice always wins.
                </p>
              </div>
              {canEdit && <RebuildButton ids={ids} disabled={running} />}
            </div>
            <div className="mb-3 flex items-center gap-2 text-[12px] text-faint">
              {running ? (
                <span className="text-warning">
                  Rebuilding{rb.phase ? ` — ${rb.phase}` : " — queued"}
                  {rb.total ? (
                    <span className="tnum">
                      {" "}
                      ({rb.satisfied}/{rb.total})
                    </span>
                  ) : null}
                </span>
              ) : rb.finishedAt ? (
                <span>
                  Last rebuilt <When at={rb.finishedAt} />
                </span>
              ) : (
                <span>Not rebuilt yet</span>
              )}
              <span>·</span>
              <span className="tnum">{s.queue.pending} classifications pending</span>
              {s.queue.failed > 0 && <span className="tnum text-destructive">· {s.queue.failed} failed</span>}
            </div>
            <DomainsEditor ids={ids} domains={s.domains} canEdit={canEdit} />
          </section>

          <section>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">HTTP grouping rules</h2>
            <p className="mb-3 text-[12px] text-faint">
              How an HTTP path becomes a concept: skip these leading segments, then take the first one.{" "}
              <span className="tnum">Rule v{s.ruleVersion}</span>
            </p>
            <HttpRulesEditor ids={ids} rules={s.httpRules} canEdit={canEdit} />
          </section>

          <section>
            <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em]">Workspace</h2>
            <ul className="divide-y rounded-md border">
              {ADMIN.map(([seg, label, hint]) => (
                <li key={seg}>
                  <Link href={`${base}/${seg}`} className="flex h-12 items-center gap-3 px-3 hover:bg-muted">
                    <div className="flex-1">
                      <div className="text-[13px] font-medium">{label}</div>
                      <div className="text-[12px] text-faint">{hint}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-faint" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
