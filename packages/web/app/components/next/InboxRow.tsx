import Link from "next/link";
import type { InboxItem } from "@/lib/next-data";
import { When } from "@/components/When";
import { btn, railFor } from "./bits";
import { VerdictButton } from "./VerdictButton";
import { KIND_WORD, affects } from "@/lib/words";
import { cn } from "@/lib/utils";

/** Which decision an item is reviewed through (conflicts → the product constraint). */
export function briefFor(it: InboxItem): string | null {
  if (it.kind === "proposal" || it.kind === "ratification" || it.kind === "review_due") return it.id;
  if (it.kind === "conflict") return typeof it.meta.decisionId === "string" ? it.meta.decisionId : null;
  if (it.kind === "placement") return typeof it.meta.itemId === "string" ? it.meta.itemId : null;
  return null;
}

function hrefOf(it: InboxItem, base: string): string {
  switch (it.kind) {
    case "conflict":
      return it.conceptId ? `${base}/map?concept=${it.conceptId}` : `${base}/inbox`;
    case "question":
      return `${base}/questions`;
    case "task":
      return `${base}/tasks`;
    case "placement":
      return it.conceptId ? `${base}/map?concept=${it.conceptId}` : `${base}/map?group=unplaced`;
    case "check_finding":
      return `${base}/ledger?tab=standards`;
    case "exception_request":
      return `/org/${base.split("/")[2]}/exceptions`;
    case "rollout_failure":
      return `/org/${base.split("/")[2]}/rollouts/${String(it.meta.assignmentId ?? "")}`;
    default:
      return `${base}/decisions/${it.id}`;
  }
}

export function InboxRow({
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
  const Act = ({ op, label, kind = "outline" }: { op: string; label?: string; kind?: keyof typeof btn }) => (
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
          "w-[76px] shrink-0 text-[11px] font-medium",
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
      {!compact && affects(it.impact) && (
        <span className="tnum w-[104px] shrink-0 text-right text-[11px] text-faint">{affects(it.impact)}</span>
      )}
      <When at={it.createdAt} className="tnum w-12 shrink-0 text-right text-[11px] text-faint" />
      {!compact && (
        <div className="flex shrink-0 items-center gap-1 opacity-60 empty:hidden transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {it.kind === "proposal" && status === "proposed" && (
            <>
              <Act op="confirm" />
              <Act op="reject" kind="ghost" />
            </>
          )}
          {it.kind === "proposal" && status === "open" && <Act op="ack" />}
          {it.kind === "ratification" && (
            <>
              <Act op="ratify" />
              <Act op="reject" kind="ghost" />
            </>
          )}
          {it.kind === "placement" && it.meta.state === "suggested" && it.conceptId && (
            <Act op="place" label={`Confirm in ${it.conceptLabel}`} />
          )}
          {it.kind === "conflict" && (
            <>
              <Act op="holds" />
              <Act op="dismiss" kind="ghost" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
