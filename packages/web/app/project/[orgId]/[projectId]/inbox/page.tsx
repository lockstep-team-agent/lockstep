import Link from "next/link";
import { redirect } from "next/navigation";
import { getInbox, newUiEnabled, type InboxItem, type InboxKind } from "@/lib/next-data";
import { When } from "@/components/When";
import { btn, Empty, PageHead, railFor } from "@/components/next/bits";
import { ApprovalBrief } from "@/components/next/ApprovalBrief";
import { VerdictButton } from "@/components/next/VerdictButton";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const KINDS: Array<{ k: InboxKind; label: string }> = [
  { k: "conflict", label: "Conflicts" },
  { k: "proposal", label: "Proposals" },
  { k: "ratification", label: "Ratifications" },
  { k: "question", label: "Questions" },
  { k: "task", label: "Tasks" },
  { k: "review_due", label: "Review due" },
];
const SEVERITY = ["Housekeeping", "Normal", "High", "Blocking"] as const;
const KIND_WORD: Record<InboxKind, string> = {
  conflict: "Conflict",
  proposal: "Proposal",
  ratification: "Ratify",
  question: "Question",
  task: "Task",
  review_due: "Review due",
  placement: "Placement",
};

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { kind?: string; cursor?: string; hk?: string; item?: string };
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  if (!newUiEnabled()) redirect(base);
  const hk = searchParams.hk === "1";
  const kind = KINDS.find((x) => x.k === searchParams.kind)?.k ?? (hk ? "placement" : undefined);
  const inbox = await getInbox(orgId, projectId, { cursor: searchParams.cursor, kinds: kind, housekeeping: hk });
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
      <PageHead title="Inbox" meta={<span className="tnum">{open} open</span>} />
      <div className="flex items-center gap-1 border-b px-4 py-1.5">
        {chip(`${base}/inbox`, "All", open, !kind)}
        {KINDS.map(({ k, label }) => chip(`${base}/inbox?kind=${k}`, label, inbox.counts[k], kind === k))}
        <div className="ml-auto">{chip(`${base}/inbox?hk=1`, "Housekeeping", inbox.housekeeping, hk)}</div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-w-0 overflow-y-auto", selected ? "w-[46%] shrink-0 border-r" : "flex-1")}>
          {inbox.items.length === 0 ? (
            <Empty
              title={kind ? "Nothing of this kind needs you" : "You’re caught up"}
              hint={
                !kind && inbox.housekeeping > 0
                  ? `${inbox.housekeeping} placement suggestions are waiting under Housekeeping.`
                  : undefined
              }
            />
          ) : (
            <ul className="pb-8">
              {inbox.items.map((it) => {
                const header = it.severity !== lastSev ? SEVERITY[it.severity] : null;
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
                    <Row
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

/** Which decision an item is reviewed through (conflicts → the product constraint). */
function briefFor(it: InboxItem): string | null {
  if (it.kind === "proposal" || it.kind === "ratification" || it.kind === "review_due") return it.id;
  if (it.kind === "conflict") return typeof it.meta.decisionId === "string" ? it.meta.decisionId : null;
  if (it.kind === "placement") return typeof it.meta.itemId === "string" ? it.meta.itemId : null;
  return null;
}

function hrefOf(it: InboxItem, base: string): string {
  switch (it.kind) {
    case "conflict":
      return it.conceptId ? `${base}/map?concept=${it.conceptId}` : `${base}/review-queue`;
    case "question":
      return `${base}/questions`;
    case "task":
      return `${base}/tasks`;
    case "placement":
      return it.conceptId ? `${base}/map?concept=${it.conceptId}` : `${base}/map?group=unplaced`;
    default:
      return `${base}/decisions/${it.id}`;
  }
}

function Row({
  it,
  base,
  orgId,
  projectId,
  briefHref,
  active,
  compact,
}: {
  it: InboxItem;
  base: string;
  orgId: string;
  projectId: string;
  briefHref: string | null;
  active: boolean;
  compact: boolean;
}) {
  const status = String(it.meta.status ?? "");
  const rail =
    it.kind === "conflict"
      ? railFor(null, {
          conflict: it.meta.conflictKind !== "drift" || it.severity === 3,
          drift: it.meta.conflictKind === "drift" && it.severity < 3,
        })
      : it.kind === "review_due"
        ? railFor("binding")
        : it.kind === "proposal" || it.kind === "ratification"
          ? railFor("proposed")
          : "rail rail-none";
  const Act = ({ op, label, kind = "outline" }: { op: string; label: string; kind?: keyof typeof btn }) => (
    <VerdictButton
      orgId={orgId}
      projectId={projectId}
      id={it.id}
      op={op}
      label={label}
      kind={kind}
      extra={
        op === "ack"
          ? { version: String(it.meta.version ?? 0) }
          : op === "place"
            ? { itemId: String(it.meta.itemId ?? ""), conceptId: it.conceptId ?? "" }
            : undefined
      }
    />
  );
  return (
    <div
      tabIndex={-1}
      data-row=""
      className={cn(
        rail,
        "group flex min-h-[40px] items-center gap-4 py-2 pl-6 pr-4 outline-none hover:bg-muted focus-visible:bg-muted",
        active && "bg-muted",
      )}
    >
      <span
        className={cn(
          "w-[72px] shrink-0 text-[11px] font-medium",
          it.kind === "conflict" ? "text-destructive" : "text-faint",
        )}
      >
        {KIND_WORD[it.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          data-row-link=""
          href={briefHref ?? hrefOf(it, base)}
          scroll={false}
          className="block truncate text-[13px] text-foreground"
        >
          {it.title}
        </Link>
        {it.detail && (
          <div className="truncate text-[11px] text-faint">
            {it.kind === "conflict" ? `vs. ${it.detail}` : it.detail}
          </div>
        )}
      </div>
      {!compact && it.conceptLabel && (
        <Link
          href={`${base}/map?concept=${it.conceptId}`}
          className="hidden shrink-0 rounded border px-1.5 text-[11px] leading-5 text-muted-foreground hover:border-border-strong hover:text-foreground md:block"
        >
          {it.conceptLabel}
        </Link>
      )}
      {!compact && it.impact > 0 && (
        <span className="tnum w-14 shrink-0 text-right text-[11px] text-faint">impact {it.impact}</span>
      )}
      <When at={it.createdAt} className="tnum w-12 shrink-0 text-right text-[11px] text-faint" />
      {!compact && (
        <div className="flex shrink-0 items-center gap-1 opacity-60 empty:hidden transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {it.kind === "proposal" && status === "proposed" && (
            <>
              <Act op="confirm" label="Confirm" kind="outline" />
              <Act op="reject" label="Reject" kind="ghost" />
            </>
          )}
          {it.kind === "proposal" && status === "open" && <Act op="ack" label="Acknowledge" kind="outline" />}
          {it.kind === "ratification" && (
            <>
              <Act op="ratify" label="Ratify" kind="outline" />
              <Act op="reject" label="Reject" kind="ghost" />
            </>
          )}
          {it.kind === "placement" && it.meta.state === "suggested" && it.conceptId && (
            <Act op="place" label={`Confirm in ${it.conceptLabel}`} />
          )}
          {it.kind === "conflict" && (
            <>
              <Act op="holds" label="Constraint holds" />
              <Act op="dismiss" label="Dismiss" kind="ghost" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
