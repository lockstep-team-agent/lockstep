import Link from "next/link";
import { redirect } from "next/navigation";
import { Search } from "lucide-react";
import {
  getLedger,
  newUiEnabled,
  type LedgerContract,
  type LedgerDecision,
  type LedgerQuestion,
  type LedgerSource,
  type LedgerTab,
  type LedgerTask,
} from "@/lib/next-data";
import { When } from "@/components/When";
import { Empty, PageHead, railFor, scopeText, StateTag, SurfaceId } from "@/components/next/bits";
import { cn } from "@/lib/utils";
import { standardsEnabled } from "@/lib/org-data";
import { ProjectStandards } from "@/components/org/ProjectStandards";

export const dynamic = "force-dynamic";

const TABS: Array<{ t: LedgerTab; label: string }> = [
  { t: "decisions", label: "Decisions" },
  { t: "contracts", label: "Contracts" },
  { t: "sources", label: "Sources" },
  { t: "questions", label: "Questions" },
  { t: "tasks", label: "Tasks" },
];
const DECISION_STATUS = ["binding", "proposed", "open", "superseded", "rejected", "stale", "expired"];
const ORIGINS = [
  ["agent", "Agents"],
  ["ingested", "Threads"],
  ["document", "Product"],
] as const;

type SP = {
  tab?: string;
  q?: string;
  status?: string;
  origin?: string;
  cursor?: string;
  repo?: string;
  task?: string;
  paths?: string;
};

export default async function LedgerPage({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: SP;
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  if (!newUiEnabled()) redirect(base);
  const std = standardsEnabled() && searchParams.tab === "standards";
  const tab = TABS.find((x) => x.t === searchParams.tab)?.t ?? "decisions";
  const q = searchParams.q?.trim() || undefined;
  const opts = { q, status: searchParams.status, origin: searchParams.origin, cursor: searchParams.cursor };
  const href = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q, status: searchParams.status, origin: searchParams.origin, ...patch }))
      if (v) p.set(k, v);
    return `${base}/ledger?${p}`;
  };

  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Ledger" meta="Everything the team has decided, searchable" />
      <div className="flex items-center gap-5 border-b px-5">
        {TABS.map(({ t, label }) => (
          <Link
            key={t}
            href={`${base}/ledger?tab=${t}`}
            aria-current={tab === t && !std ? "page" : undefined}
            className={cn(
              "-mb-px flex h-10 items-center border-b-2 text-[13px] font-medium transition-colors duration-150",
              tab === t && !std
                ? "border-foreground text-foreground"
                : "border-transparent text-faint hover:text-muted-foreground",
            )}
          >
            {label}
          </Link>
        ))}
        {standardsEnabled() && (
          <Link
            href={`${base}/ledger?tab=standards`}
            aria-current={std ? "page" : undefined}
            className={cn(
              "-mb-px flex h-10 items-center border-b-2 text-[13px] font-medium transition-colors duration-150",
              std ? "border-foreground text-foreground" : "border-transparent text-faint hover:text-muted-foreground",
            )}
          >
            Standards
          </Link>
        )}
      </div>
      {std ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ProjectStandards
            orgId={orgId}
            projectId={projectId}
            base={base}
            why={{ repoId: searchParams.repo, taskType: searchParams.task, paths: searchParams.paths }}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b px-5 py-2">
            <form className="relative" action={`${base}/ledger`}>
              <input type="hidden" name="tab" value={tab} />
              {searchParams.status && <input type="hidden" name="status" value={searchParams.status} />}
              {searchParams.origin && <input type="hidden" name="origin" value={searchParams.origin} />}
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input
                name="q"
                defaultValue={q}
                placeholder={tab === "contracts" ? "Filter surfaces…" : "Search…"}
                aria-label="Search the ledger"
                className="h-7 w-72 rounded-md border bg-muted pl-7 pr-2 text-[12px] outline-none placeholder:text-faint focus:border-border-strong"
              />
            </form>
            {tab === "decisions" && (
              <div className="flex items-center gap-0.5">
                {ORIGINS.map(([o, label]) => (
                  <Filter
                    key={o}
                    href={href({ origin: searchParams.origin === o ? undefined : o, cursor: undefined })}
                    active={searchParams.origin === o}
                  >
                    {label}
                  </Filter>
                ))}
                <span className="mx-1.5 h-4 w-px bg-border" />
                {DECISION_STATUS.map((s) => (
                  <Filter
                    key={s}
                    href={href({ status: searchParams.status === s ? undefined : s, cursor: undefined })}
                    active={searchParams.status === s}
                  >
                    {s}
                  </Filter>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "decisions" && (
              <Decisions orgId={orgId} projectId={projectId} base={base} opts={opts} href={href} />
            )}
            {tab === "contracts" && (
              <Contracts orgId={orgId} projectId={projectId} base={base} opts={opts} href={href} />
            )}
            {tab === "sources" && <Sources orgId={orgId} projectId={projectId} base={base} opts={opts} href={href} />}
            {tab === "questions" && (
              <Questions orgId={orgId} projectId={projectId} base={base} opts={opts} href={href} />
            )}
            {tab === "tasks" && <Tasks orgId={orgId} projectId={projectId} opts={opts} href={href} />}
          </div>
        </>
      )}
    </div>
  );
}

function Filter({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-pressed={active}
      className={cn(
        "h-6 rounded px-2 text-[11px] font-medium leading-6 transition-colors duration-150",
        active ? "bg-muted text-foreground" : "text-faint hover:text-muted-foreground",
      )}
    >
      {children}
    </Link>
  );
}

type TabProps = {
  orgId: string;
  projectId: string;
  base: string;
  opts: Record<string, string | undefined>;
  href: (p: Partial<SP>) => string;
};

function Head({ cols, children }: { cols: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "sticky top-0 z-[1] grid gap-4 border-b bg-background px-5 py-1.5 text-[11px] font-medium text-faint",
        cols,
      )}
    >
      {children}
    </div>
  );
}
function Next({ href }: { href: string | null }) {
  return href ? (
    <div className="px-5 py-3">
      <Link href={href} className="text-[12px] text-faint hover:text-foreground">
        Next page →
      </Link>
    </div>
  ) : null;
}
function ConceptCell({ base, c }: { base: string; c: LedgerDecision["concept"] }) {
  return c ? (
    <Link
      href={`${base}/map?concept=${c.id}`}
      className="truncate text-[12px] text-muted-foreground hover:text-foreground"
    >
      {c.label}
    </Link>
  ) : (
    <span className="text-[12px] text-faint">—</span>
  );
}

async function Decisions({ orgId, projectId, base, opts, href }: TabProps) {
  const r = await getLedger<LedgerDecision>(orgId, projectId, "decisions", opts);
  if (!r) return <Empty title="Couldn’t load decisions" />;
  if (r.rows.length === 0) return <Empty title="No decisions match" />;
  const cols = "grid-cols-[minmax(0,1fr)_160px_90px_64px]";
  return (
    <>
      <Head cols={cols}>
        <span>Rule</span>
        <span>Concept</span>
        <span>Status</span>
        <span className="text-right">Created</span>
      </Head>
      {r.rows.map((d) => (
        <div
          key={d.id}
          tabIndex={-1}
          data-row=""
          className={cn(
            railFor(d.status),
            "grid items-center gap-4 py-1.5 pl-5 pr-5 outline-none hover:bg-muted focus-visible:bg-muted",
            cols,
          )}
        >
          <div className="min-w-0">
            <Link data-row-link="" href={`${base}/decisions/${d.id}`} className="block truncate text-[13px]">
              {d.rule_text ?? d.scope_ref}
            </Link>
            <div className="truncate text-[11px] text-faint">
              {d.scope_kind === "surface" ? (
                <SurfaceId surface={d.scope_ref} className="text-[11px]" />
              ) : (
                scopeText(d.scope_kind, d.scope_label)
              )}
              {d.origin === "document" && " · product"}
              {d.constraint_kind && ` · ${d.constraint_kind.replace("_", " ")}`}
            </div>
          </div>
          <ConceptCell base={base} c={d.concept} />
          <StateTag state={d.status} />
          <When at={d.created_at} className="tnum text-right text-[11px] text-faint" />
        </div>
      ))}
      <Next href={r.nextCursor ? href({ cursor: r.nextCursor }) : null} />
    </>
  );
}

async function Contracts({ orgId, projectId, base, opts, href }: TabProps) {
  const r = await getLedger<LedgerContract>(orgId, projectId, "contracts", opts);
  if (!r) return <Empty title="Couldn’t load contracts" />;
  if (r.rows.length === 0)
    return <Empty title="No contracts match" hint="Contracts appear when a repo syncs the surfaces it produces." />;
  const cols = "grid-cols-[minmax(0,1fr)_160px_90px_80px_64px]";
  return (
    <>
      <Head cols={cols}>
        <span>Surface</span>
        <span>Concept</span>
        <span className="text-right">Consumers</span>
        <span className="text-right">Governed by</span>
        <span className="text-right">Changes</span>
      </Head>
      {r.rows.map((s) => (
        <div
          key={s.id}
          tabIndex={-1}
          data-row=""
          className={cn("grid items-center gap-4 px-5 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted", cols)}
        >
          <div className="min-w-0">
            <Link
              data-row-link=""
              href={s.concept ? `${base}/map?concept=${s.concept.id}&tab=contracts` : "#"}
              className="block truncate"
            >
              <SurfaceId surface={s.surface} />
            </Link>
            <div className="truncate text-[11px] text-faint">
              {s.git_remote?.replace(/^(https?:\/\/)?(www\.)?/, "")}
            </div>
          </div>
          <ConceptCell base={base} c={s.concept} />
          <span className={cn("tnum text-right text-[12px]", s.consumers ? "text-foreground" : "text-faint")}>
            {s.consumers}
          </span>
          <span className={cn("tnum text-right text-[12px]", s.governing ? "text-foreground" : "text-faint")}>
            {s.governing}
          </span>
          <span className="tnum text-right text-[12px] text-faint">{s.changes}</span>
        </div>
      ))}
      <Next href={r.nextCursor ? href({ cursor: r.nextCursor }) : null} />
    </>
  );
}

async function Sources({ orgId, projectId, base, opts, href }: TabProps) {
  const r = await getLedger<LedgerSource>(orgId, projectId, "sources", opts);
  if (!r) return <Empty title="Couldn’t load sources" />;
  if (r.rows.length === 0)
    return (
      <Empty
        title="No sources yet"
        hint={
          <>
            Connect a PRD from the{" "}
            <Link href={`${base}/sources`} className="underline">
              sources page
            </Link>{" "}
            to extract product constraints.
          </>
        }
      />
    );
  const cols = "grid-cols-[minmax(0,1fr)_90px_80px_90px_64px]";
  return (
    <>
      <Head cols={cols}>
        <span>Document</span>
        <span>Tool</span>
        <span>State</span>
        <span className="text-right">Constraints</span>
        <span className="text-right">Added</span>
      </Head>
      {r.rows.map((d) => (
        <div
          key={d.id}
          tabIndex={-1}
          data-row=""
          className={cn("grid items-center gap-4 px-5 py-2 outline-none hover:bg-muted focus-visible:bg-muted", cols)}
        >
          <Link data-row-link="" href={`${base}/sources/${d.id}`} className="truncate text-[13px]">
            {d.title ?? "(untitled)"}
          </Link>
          <span className="text-[12px] text-faint">{d.tool}</span>
          <StateTag state={d.state} />
          <span className="tnum text-right text-[12px]">{d.constraints}</span>
          <When at={d.created_at} className="tnum text-right text-[11px] text-faint" />
        </div>
      ))}
      <Next href={r.nextCursor ? href({ cursor: r.nextCursor }) : null} />
    </>
  );
}

async function Questions({ orgId, projectId, base, opts, href }: TabProps) {
  const r = await getLedger<LedgerQuestion>(orgId, projectId, "questions", opts);
  if (!r) return <Empty title="Couldn’t load questions" />;
  if (r.rows.length === 0)
    return <Empty title="No questions" hint="Agents ask here when a change needs an owner’s answer." />;
  const cols = "grid-cols-[minmax(0,1fr)_80px_80px_64px]";
  return (
    <>
      <Head cols={cols}>
        <span>Question</span>
        <span>Status</span>
        <span className="text-right">Answers</span>
        <span className="text-right">Asked</span>
      </Head>
      {r.rows.map((x) => (
        <div
          key={x.id}
          tabIndex={-1}
          data-row=""
          className={cn("grid items-center gap-4 px-5 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted", cols)}
        >
          <Link data-row-link="" href={`${base}/questions`} className="min-w-0 truncate text-[13px]">
            {x.urgent && <span className="mr-1.5 text-[11px] font-semibold text-destructive">urgent</span>}
            {x.body}
          </Link>
          <StateTag state={x.status} />
          <span className="tnum text-right text-[12px]">{x.answers}</span>
          <When at={x.created_at} className="tnum text-right text-[11px] text-faint" />
        </div>
      ))}
      <Next href={r.nextCursor ? href({ cursor: r.nextCursor }) : null} />
    </>
  );
}

async function Tasks({ orgId, projectId, opts, href }: Omit<TabProps, "base">) {
  const r = await getLedger<LedgerTask>(orgId, projectId, "tasks", opts);
  if (!r) return <Empty title="Couldn’t load tasks" />;
  if (r.rows.length === 0) return <Empty title="No tasks" hint="Work delegated between agents shows up here." />;
  const cols = "grid-cols-[minmax(0,1fr)_90px_80px_64px]";
  return (
    <>
      <Head cols={cols}>
        <span>Task</span>
        <span>Run state</span>
        <span>Status</span>
        <span className="text-right">Created</span>
      </Head>
      {r.rows.map((t) => (
        <div
          key={t.id}
          tabIndex={-1}
          data-row=""
          className={cn("grid items-center gap-4 px-5 py-1.5 outline-none hover:bg-muted focus-visible:bg-muted", cols)}
        >
          <span className="truncate text-[13px]">{t.title}</span>
          <span className="text-[12px] text-faint">{t.run_state}</span>
          <StateTag state={t.status} />
          <When at={t.created_at} className="tnum text-right text-[11px] text-faint" />
        </div>
      ))}
      <Next href={r.nextCursor ? href({ cursor: r.nextCursor }) : null} />
    </>
  );
}
