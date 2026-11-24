import Link from "next/link";
import { getInbox, type InboxKind } from "@/lib/next-data";
import { Empty, PageHead } from "@/components/next/bits";
import { ApprovalBrief } from "@/components/next/ApprovalBrief";
import { InboxRow, briefFor } from "@/components/next/InboxRow";
import { KIND_TAB, SEVERITY_WORD } from "@/lib/words";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const KINDS: Array<{ k: InboxKind; label: string }> = (
  ["conflict", "proposal", "ratification", "question", "task", "review_due", "check_finding", "exception_request"] as const
).map((k) => ({ k, label: KIND_TAB[k] ?? k }));

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { kind?: string; cursor?: string; hk?: string; item?: string };
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const hk = searchParams.hk === "1";
  const kind = KINDS.find((x) => x.k === searchParams.kind)?.k ?? (hk ? "placement" : undefined);
  // Housekeeping = placement suggestions + aggregated skill-install failures.
  const inbox = await getInbox(orgId, projectId, {
    cursor: searchParams.cursor,
    kinds: hk && !searchParams.kind ? "placement,rollout_failure" : kind,
    housekeeping: hk,
  });
  if (!inbox) return <Empty title="Couldn’t load the inbox" hint="The API didn’t respond. Try again in a moment." />;
  const open = KINDS.reduce((a, { k }) => a + (inbox.counts[k] ?? 0), 0);
  const chip = (href: string, label: string, n: number | undefined, active: boolean) => (
    <Link
      key={label}
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors duration-150",
        active ? "bg-muted text-foreground" : "text-faint hover:text-muted-foreground",
      )}
    >
      {label}
      {n != null && n > 0 && <span className="tnum text-[11px] font-normal text-faint">{n}</span>}
    </Link>
  );

  // the decision to brief: ?item= keeps list filters, so j/k + Enter walks the queue with the panel open
  const selected = searchParams.item;
  const listHref = (extra: Record<string, string>) =>
    `${base}/inbox?${new URLSearchParams({
      ...(searchParams.kind ? { kind: searchParams.kind } : {}),
      ...(hk ? { hk: "1" } : {}),
      ...(searchParams.cursor ? { cursor: searchParams.cursor } : {}),
      ...extra,
    })}`;
  let lastSev: number | null = null;
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Everything open" meta={<span className="tnum">{open} open</span>} />
      <div className="flex items-center gap-1 border-b px-4 py-1.5">
        {chip(`${base}/inbox`, "All", open, !kind)}
        {KINDS.map(({ k, label }) => chip(`${base}/inbox?kind=${k}`, label, inbox.counts[k], kind === k))}
        <div className="ml-auto">{chip(`${base}/inbox?hk=1`, "Low priority", inbox.housekeeping, hk)}</div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-w-0 overflow-y-auto", selected ? "w-[46%] shrink-0 border-r" : "flex-1")}>
          {inbox.items.length === 0 ? (
            <Empty
              title={kind ? "Nothing of this kind needs you" : "You’re caught up"}
              hint={
                !kind && inbox.housekeeping > 0
                  ? `${inbox.housekeeping} filing suggestions are waiting under Low priority.`
                  : undefined
              }
            />
          ) : (
            <ul className="pb-8">
              {inbox.items.map((it) => {
                const header = it.severity !== lastSev ? SEVERITY_WORD[it.severity] : null;
                lastSev = it.severity;
                return (
                  <li key={`${it.kind}-${it.id}`}>
                    {header && (
                      <div
                        className={cn(
                          "px-6 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em]",
                          it.severity === 3 ? "text-destructive" : "text-faint",
                        )}
                      >
                        {header}
                      </div>
                    )}
                    <InboxRow
                      it={it}
                      base={base}
                      orgId={orgId}
                      projectId={projectId}
                      briefHref={briefFor(it) ? listHref({ item: briefFor(it)! }) : null}
                      active={!!selected && briefFor(it) === selected}
                      compact={!!selected}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {inbox.nextCursor && (
            <div className="px-6 pb-6">
              <Link
                href={`${base}/inbox?${new URLSearchParams({ ...(searchParams.kind ? { kind: searchParams.kind } : {}), ...(hk ? { hk: "1" } : {}), cursor: inbox.nextCursor })}`}
                className="text-[12px] text-faint hover:text-foreground"
              >
                Next page →
              </Link>
            </div>
          )}
        </div>
        {selected && (
          <aside aria-label="Decision brief" className="min-w-0 flex-1 overflow-y-auto">
            <div className="flex h-9 items-center border-b px-5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">Review</span>
              <Link
                href={listHref({})}
                scroll={false}
                className="ml-auto text-[12px] text-faint hover:text-foreground"
                aria-label="Close review panel"
              >
                Close ✕
              </Link>
            </div>
            <ApprovalBrief orgId={orgId} projectId={projectId} decisionId={selected} mode="panel" />
          </aside>
        )}
      </div>
    </div>
  );
}

