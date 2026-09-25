import Link from "next/link";
import type { ReactNode } from "react";
import { ExternalLink, FileText, GitCommitHorizontal, MessagesSquare, Bot, ArrowRight } from "lucide-react";
import { getDecisionBrief, type DecisionBrief } from "@/lib/next-data";
import { When } from "@/components/When";
import { cn } from "@/lib/utils";
import { BriefSummary } from "./BriefSummary";
import { VerdictButton } from "./VerdictButton";
import { VerdictBar, type VerdictSpec } from "./VerdictBar";
import { ProposeVersionSheet } from "@/project/[orgId]/[projectId]/decisions/[id]/ProposeVersionSheet";
import { btn, Empty, railFor, scopeText, StateTag, SurfaceId } from "./bits";

type Ids = { orgId: string; projectId: string };

const CHANNEL = {
  document: { icon: FileText, word: "a product document" },
  conversation: { icon: MessagesSquare, word: "a team conversation" },
  agent: { icon: Bot, word: "a coding agent" },
} as const;

/** One factual sentence, used until (or instead of) the generated summary. */
function factualWhy(b: DecisionBrief): string {
  const who = b.proposedBy ? ` by @${b.proposedBy}` : "";
  const src = b.raisedFrom.document?.title ? ` (“${b.raisedFrom.document.title}”)` : "";
  const quotes = b.provenances.reduce((a, p) => a + (p.evidence?.length ?? 0), 0);
  const open = b.conflictsDetail.filter((c) => c.status === "open").length;
  return [
    `Raised from ${CHANNEL[b.raisedFrom.channel].word}${src}${who}.`,
    quotes ? `${quotes} quoted source line${quotes === 1 ? "" : "s"} back it.` : "No quoted evidence was captured.",
    open ? `It is in ${open} open conflict${open === 1 ? "" : "s"}.` : "",
    b.consumers.length
      ? `${b.consumers.length} consumer repo${b.consumers.length === 1 ? "" : "s"} would be affected.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-t px-5 py-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">
        {title}
        {count != null && <span className="tnum ml-1.5 font-normal">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Act({
  ids,
  id,
  op,
  label,
  kind = "outline",
  extra,
}: {
  ids: Ids;
  id: string;
  op: string;
  label: string;
  kind?: keyof typeof btn;
  extra?: Record<string, string>;
}) {
  return (
    <VerdictButton
      orgId={ids.orgId}
      projectId={ids.projectId}
      id={id}
      op={op}
      label={label}
      kind={kind}
      extra={extra}
    />
  );
}

/** The verdict buttons that apply to this decision's state — and only those. */
function Verdicts({ ids, b }: { ids: Ids; b: DecisionBrief }) {
  const reviewDue =
    b.status === "binding" &&
    [b.reviewAt, b.expiresAt].some((t) => t && new Date(t).getTime() < Date.now() + 7 * 86_400_000);
  let actions: VerdictSpec[] = [];
  let blocked: string | null = null;
  if (b.status === "proposed" && b.origin === "document") {
    // ratification needs an Active source PRD; say so up front instead of failing on click
    const reason = !b.raisedFrom.document
      ? "Can’t ratify: no source document is linked."
      : b.raisedFrom.document.state !== "active"
        ? `Can’t ratify until “${b.raisedFrom.document.title ?? "the source document"}” is Active.`
        : null;
    actions = [
      { op: "ratify", label: "Ratify", kind: "primary", disabled: Boolean(reason) },
      { op: "reject", label: "Reject", kind: "ghost" },
    ];
    blocked = reason;
  } else if (b.status === "proposed") {
    actions = [
      { op: "confirm", label: "Confirm", kind: "primary" },
      { op: "reject", label: "Reject", kind: "ghost" },
    ];
  } else if (b.status === "open") {
    actions = [{ op: "ack", label: "Acknowledge", kind: "primary", extra: { version: String(b.currentVersion) } }];
  } else if (reviewDue) {
    actions = [{ op: "reviewed", label: "Mark reviewed" }];
  }
  return (
    <VerdictBar
      orgId={ids.orgId}
      projectId={ids.projectId}
      decisionId={b.id}
      actions={actions}
      blocked={blocked}
      target={b.writeback.target}
      history={b.writeback.history}
    />
  );
}

export async function ApprovalBrief({
  orgId,
  projectId,
  decisionId,
  mode,
}: {
  orgId: string;
  projectId: string;
  decisionId: string;
  mode: "panel" | "page";
}) {
  const b = await getDecisionBrief(orgId, projectId, decisionId);
  if (!b)
    return (
      <Empty title="This decision couldn’t be loaded" hint="It may belong to another project, or it was removed." />
    );
  const ids = { orgId, projectId };
  const base = `/project/${orgId}/${projectId}`;
  const Channel = CHANNEL[b.raisedFrom.channel].icon;
  const openConflicts = b.conflictsDetail.filter((c) => c.status === "open");
  const quotes = b.provenances.flatMap((p) =>
    (p.evidence ?? []).map((e) => ({ ...e, source: p.source, url: p.url, confidence: p.confidence })),
  );

  return (
    <article className="flex min-h-full flex-col">
      {/* header: the rule leads; everything else is quiet metadata */}
      <header className="px-5 pb-4 pt-5">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
          <StateTag state={b.status} />
          <span>·</span>
          <span>{b.origin === "document" ? "product constraint" : b.decisionType}</span>
          {b.constraintKind && <span>· {b.constraintKind.replace("_", " ")}</span>}
          <span>·</span>
          <span className="tnum">v{b.currentVersion}</span>
          <span>·</span>
          <When at={b.createdAt} />
          {mode === "panel" && (
            <Link href={`${base}/decisions/${b.id}`} className="ml-auto text-faint hover:text-foreground">
              Open full page →
            </Link>
          )}
        </div>
        <h2
          className={cn(
            railFor(b.status, { conflict: openConflicts.length > 0 }),
            "pl-3 font-semibold tracking-[-0.01em]",
            mode === "page" ? "text-[22px] leading-7" : "text-[17px] leading-6",
          )}
        >
          {b.ruleText || b.scopeRef}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-3 text-[12px] text-faint">
          {b.scopeKind === "surface" ? (
            <SurfaceId surface={b.scopeRef} />
          ) : (
            <span>{scopeText(b.scopeKind, b.scopeRef)}</span>
          )}
          {b.concept && (
            <Link
              href={`${base}/map?concept=${b.concept.id}`}
              className="rounded border px-1.5 leading-5 text-muted-foreground hover:border-border-strong hover:text-foreground"
            >
              {b.concept.domain ? `${b.concept.domain} › ` : ""}
              {b.concept.label}
            </Link>
          )}
          {b.impact > 0 && <span className="tnum">impact {b.impact}</span>}
        </div>
        <div className="mt-4 flex items-start gap-1.5 pl-3">
          <div className="min-w-0 flex-1">
            <Verdicts ids={ids} b={b} />
          </div>
          {mode === "page" && b.origin !== "document" && !["superseded", "rejected"].includes(b.status) && (
            <span className="ml-auto">
              <ProposeVersionSheet
                orgId={orgId}
                projectId={projectId}
                id={b.id}
                scopeKind={b.scopeKind}
                scopeRef={b.scopeRef}
                decisionType={b.decisionType}
                baseVersion={b.currentVersion}
                ruleText={b.ruleText}
                rationale={b.rationale}
              />
            </span>
          )}
        </div>
      </header>

      <Section title="Why this was raised">
        <BriefSummary
          orgId={orgId}
          projectId={projectId}
          decisionId={b.id}
          initial={b.summary?.text ?? null}
          fallback={factualWhy(b)}
        />
      </Section>

      {openConflicts.length > 0 && (
        <Section title="In conflict with" count={openConflicts.length}>
          <ul className="space-y-2">
            {openConflicts.map((c) => (
              <li key={c.id} className="rail rail-conflict rounded-md border border-destructive-edge py-2.5 pl-4 pr-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-0.5 text-[11px] text-faint">
                      This {c.side === "constraint" ? "product constraint" : "decision"}
                    </div>
                    <div className="text-[13px]">{b.ruleText}</div>
                  </div>
                  <div>
                    <div className="mb-0.5 text-[11px] text-faint">
                      {c.other?.origin === "document" ? "Product constraint" : "Engineering decision"}
                      {c.other?.status ? ` · ${c.other.status}` : ""}
                    </div>
                    {c.other ? (
                      <Link href={`${base}/decisions/${c.other.id}`} className="text-[13px] hover:underline">
                        {c.other.ruleText ?? "(rule)"}
                      </Link>
                    ) : (
                      <span className="text-[13px] text-faint">A pending change on this surface</span>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <SurfaceId surface={c.surface} className="text-[11px] text-faint" />
                  <span className="text-[11px] text-faint">
                    {c.kind === "drift"
                      ? "drift — the code moved against the constraint"
                      : "pre-approval — flagged before ratification"}{" "}
                    · <When at={c.openedAt} />
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Act ids={ids} id={c.id} op="holds" label="Constraint holds" />
                    <Act ids={ids} id={c.id} op="dismiss" label="Dismiss" kind="ghost" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Source & evidence">
        <div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
          <Channel className="h-3.5 w-3.5 text-faint" />
          <span>
            From {CHANNEL[b.raisedFrom.channel].word}
            {b.proposedBy && (
              <>
                {" "}
                · proposed by <span className="text-foreground">@{b.proposedBy}</span>
              </>
            )}
            {b.raisedFrom.decidedBy && <> · decided by {b.raisedFrom.decidedBy}</>}
            {b.raisedFrom.extractor && <> · extracted by {b.raisedFrom.extractor}</>}
          </span>
        </div>
        {b.raisedFrom.document && (
          <div className="mb-2 flex items-center gap-2 rounded-md border px-3 py-2">
            <FileText className="h-4 w-4 text-faint" />
            <Link
              href={`${base}/sources/${b.raisedFrom.document.id}`}
              className="min-w-0 flex-1 truncate text-[13px] hover:underline"
            >
              {b.raisedFrom.document.title ?? "(untitled document)"}
            </Link>
            <span className="text-[11px] text-faint">{b.raisedFrom.document.tool}</span>
            <StateTag state={b.raisedFrom.document.state} />
            {b.raisedFrom.document.url && (
              <a
                href={b.raisedFrom.document.url}
                target="_blank"
                rel="noreferrer"
                aria-label="Open document"
                className="text-faint hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
        {b.raisedFrom.sources
          .filter((s) => s.anchor)
          .map((s, i) => {
            const a = s.anchor as { headingPath?: string[]; snippet?: string };
            return (
              <div key={i} className="mb-2 text-[12px] text-faint">
                Section: <span className="text-muted-foreground">{(a.headingPath ?? []).join(" › ") || "—"}</span>
                {s.anchorStatus !== "valid" && <span className="ml-1 text-warning">({s.anchorStatus})</span>}
              </div>
            );
          })}
        {quotes.length > 0 ? (
          <ul className="space-y-2">
            {quotes.slice(0, mode === "panel" ? 3 : 20).map((q, i) => (
              <li key={i} className="border-l-2 border-border-strong pl-3">
                <blockquote className="text-[13px] leading-5 text-foreground">“{q.quote}”</blockquote>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                  <span>{q.source}</span>
                  {q.confidence != null && <span className="tnum">{Math.round(q.confidence * 100)}% confidence</span>}
                  {q.url && (
                    <a
                      href={q.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 hover:text-foreground"
                    >
                      open <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-faint">
            No quoted evidence was captured for this decision
            {b.origin === "agent" ? " — agents propose rules directly from the work in progress" : ""}.
          </p>
        )}
      </Section>

      {(b.rationale || (b.alternatives?.length ?? 0) > 0) && (
        <Section title="Rationale">
          {b.rationale && <p className="text-[13px] leading-5">{b.rationale}</p>}
          {(b.alternatives?.length ?? 0) > 0 && (
            <div className="mt-2">
              <div className="text-[11px] text-faint">Considered and rejected</div>
              <ul className="mt-0.5 list-disc pl-5 text-[12px] text-muted-foreground">
                {b.alternatives!.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <Section title="What it touches">
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
          <dt className="text-faint">Consumers</dt>
          <dd>
            {b.consumers.length === 0 ? (
              <span className="text-faint">
                none declared{b.scopeKind !== "surface" ? " (not surface-scoped)" : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">
                <span className="tnum text-foreground">{b.consumers.length}</span> repo
                {b.consumers.length === 1 ? "" : "s"}:{" "}
                {[...new Set(b.consumers.map((c) => c.gitRemote?.split("/").pop() ?? "repo"))].slice(0, 6).join(", ")}
              </span>
            )}
          </dd>
          {b.supersedesHint && (
            <>
              <dt className="text-faint">Would replace</dt>
              <dd>
                <Link
                  href={`${base}/decisions/${b.supersedesHint.id}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {b.supersedesHint.ruleText}
                </Link>
              </dd>
            </>
          )}
          {b.lineage.supersededBy && (
            <>
              <dt className="text-faint">Replaced by</dt>
              <dd>
                <Link
                  href={`${base}/decisions/${b.lineage.supersededBy.id}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {b.lineage.supersededBy.ruleText}
                </Link>
              </dd>
            </>
          )}
        </dl>
        {b.neighbours.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] text-faint">
              Other rules in {b.concept?.label ?? "this concept"} — check for overlap
            </div>
            <ul>
              {b.neighbours.slice(0, mode === "panel" ? 4 : 8).map((n) => (
                <li key={n.id}>
                  <Link
                    href={`${base}/decisions/${n.id}`}
                    className={cn(
                      railFor(n.status),
                      "flex items-center gap-2 py-1 pl-3 text-[12px] text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{n.ruleText ?? n.scopeRef}</span>
                    {n.sameScope && <span className="shrink-0 text-[10px] text-warning">same scope</span>}
                    <StateTag state={n.status} className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {mode === "page" && (
        <>
          <Section title="Agreement" count={b.approvals.length}>
            {b.approvals.length === 0 ? (
              <p className="text-[12px] text-faint">No acknowledgements yet.</p>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {b.approvals.map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="text-foreground">@{a.reviewer ?? "unknown"}</span>
                    <span className="text-faint">
                      {a.verdict.replace("_", " ")} v{a.version}
                    </span>
                    {a.comment && <span className="truncate text-muted-foreground">— {a.comment}</span>}
                    <When at={a.createdAt} className="ml-auto text-faint" />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="History" count={b.versions.length}>
            <ol className="space-y-1.5">
              {b.versions.map((v) => (
                <li key={v.version} className="flex items-start gap-2 text-[12px]">
                  <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="tnum w-6 shrink-0 text-faint">v{v.version}</span>
                  <span className="min-w-0 flex-1 text-muted-foreground">{v.ruleText}</span>
                  {v.proposedBy && <span className="shrink-0 text-faint">@{v.proposedBy}</span>}
                  <When at={v.createdAt} className="shrink-0 text-faint" />
                </li>
              ))}
            </ol>
          </Section>
        </>
      )}
      {mode === "panel" && (
        <div className="border-t px-5 py-3">
          <Link
            href={`${base}/decisions/${b.id}`}
            className="inline-flex items-center gap-1 text-[12px] text-faint hover:text-foreground"
          >
            History, agreement and propose a change <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </article>
  );
}
