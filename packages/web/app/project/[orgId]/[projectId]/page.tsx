import Link from "next/link";
import { getInbox, getLedger, getPulse, type LedgerDecision } from "@/lib/next-data";
import { When } from "@/components/When";
import { Empty, PageHead } from "@/components/next/bits";
import { InboxRow, briefFor } from "@/components/next/InboxRow";

export const dynamic = "force-dynamic";

const NEEDS_YOU = 5;

/**
 * Home: proof first, then the few things that need this person, then what's in force.
 * Usability round 3: every persona wanted "what did it do for us" before any queue, and a short,
 * personal list instead of a 47-item inbox.
 */
export default async function Home({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const [pulse, inbox, rules] = await Promise.all([
    getPulse(orgId, projectId),
    getInbox(orgId, projectId),
    getLedger<LedgerDecision>(orgId, projectId, "decisions", { status: "binding" }),
  ]);
  const open = Object.values(inbox?.counts ?? {}).reduce((a, n) => a + (n ?? 0), 0);
  const needs = (inbox?.items ?? []).slice(0, NEEDS_YOU);
  const quiet = pulse && pulse.briefed + pulse.routed + pulse.caught + pulse.conflicts + pulse.rulesInForce === 0;

  return (
    <div>
      <PageHead title="Home" meta="What Lockstep did for your team, and what needs you" />

      <section aria-label="Last 7 days" className="border-b px-5 py-5">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">Last 7 days</div>
        {!pulse ? (
          <div className="text-[13px] text-faint">Couldn’t load activity.</div>
        ) : quiet ? (
          <div className="max-w-xl text-[13px] leading-6 text-muted-foreground">
            Nothing yet. Run <code className="rounded bg-muted px-1 font-mono text-[12px]">npx lockstep-cli onboard</code>{" "}
            in a repo. Your next Claude Code session gets its first briefing, and this page starts counting.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border lg:grid-cols-4">
            <Stat n={pulse.briefed} label="agent sessions briefed" hint="Sessions that started with your team’s rules" />
            <Stat
              n={pulse.routed}
              label="changes sent to affected teams"
              hint="API and contract changes delivered to the services that use them"
            />
            <Stat
              n={pulse.caught + pulse.conflicts}
              label="problems caught early"
              hint="Code that broke a rule, or rules that clashed, caught before shipping"
            />
            <Stat
              n={pulse.rulesInForce}
              label="rules agents follow"
              hint={pulse.newRules > 0 ? `${pulse.newRules} new this week` : "Binding rules in every briefing"}
            />
          </div>
        )}
      </section>

      <section aria-labelledby="needs-you" className="border-b">
        <div className="flex items-baseline gap-3 px-5 pb-1 pt-5">
          <h2 id="needs-you" className="text-[13px] font-semibold">
            Needs you
          </h2>
          <span className="text-[12px] text-faint">Most important first. Hover a button to see what it does.</span>
          {open > needs.length && (
            <Link href={`${base}/inbox`} className="ml-auto text-[12px] text-faint hover:text-foreground">
              See all {open} open →
            </Link>
          )}
        </div>
        {!inbox ? (
          <Empty title="Couldn’t load what needs you" />
        ) : needs.length === 0 ? (
          <Empty title="Nothing needs you" hint="New suggested rules and clashes show up here." />
        ) : (
          <ul className="pb-3">
            {needs.map((it) => (
              <li key={`${it.kind}-${it.id}`}>
                <InboxRow
                  it={it}
                  base={base}
                  orgId={orgId}
                  projectId={projectId}
                  briefHref={briefFor(it) ? `${base}/inbox?item=${briefFor(it)}` : null}
                  active={false}
                  compact={false}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="in-force">
        <div className="flex items-baseline gap-3 px-5 pb-1 pt-5">
          <h2 id="in-force" className="text-[13px] font-semibold">
            Rules in force
          </h2>
          <span className="text-[12px] text-faint">What every agent session is told</span>
          <Link href={`${base}/ledger`} className="ml-auto text-[12px] text-faint hover:text-foreground">
            All rules →
          </Link>
        </div>
        {!rules || rules.rows.length === 0 ? (
          <Empty title="No rules yet" hint="Rules appear here once someone makes a suggestion a rule." />
        ) : (
          <ul className="pb-6">
            {rules.rows.slice(0, 5).map((d) => (
              <li key={d.id}>
                <Link
                  href={`${base}/decisions/${d.id}`}
                  className="flex items-center gap-4 px-5 py-2 hover:bg-muted"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{d.rule_text ?? d.scope_label}</span>
                  {d.concept && (
                    <span className="hidden shrink-0 text-[11px] text-faint md:block">{d.concept.label}</span>
                  )}
                  <When at={d.created_at} className="tnum w-14 shrink-0 text-right text-[11px] text-faint" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ n, label, hint }: { n: number; label: string; hint: string }) {
  return (
    <div className="bg-background px-4 py-3" title={hint}>
      <div className="tnum text-[22px] font-semibold tracking-[-0.02em]">{n}</div>
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[11px] text-faint">{hint}</div>
    </div>
  );
}
