import Link from "next/link";
import { ExternalLink, FileText, Link2 } from "lucide-react";
import {
  getConcept,
  getConceptContracts,
  getConceptDecisions,
  getConceptSources,
  type ConceptDecision,
} from "@/lib/next-data";
import { cn } from "@/lib/utils";
import { Empty, railFor, scopeText, StateTag, SurfaceId } from "./bits";
import { ConceptActions, PlacementActions, SurfaceHistory } from "./ConceptControls";
import { VerdictButton } from "./VerdictButton";

type Tab = "decisions" | "contracts" | "sources";

/** The concept ledger: where a concept's decisions, product constraints and contracts meet. */
export async function ConceptPane({
  orgId,
  projectId,
  conceptId,
  tab,
  cursor,
  hrefFor,
  domains,
  canEdit,
}: {
  orgId: string;
  projectId: string;
  conceptId: string;
  tab: Tab;
  cursor?: string;
  hrefFor: (q: Record<string, string | undefined>) => string;
  domains: Array<{ id: string; label: string }>;
  canEdit: boolean;
}) {
  const c = await getConcept(orgId, projectId, conceptId);
  if (!c)
    return <Empty title="This concept doesn’t exist anymore" hint="It may have been merged or retired by a rebuild." />;
  const ids = { orgId, projectId };
  const base = `/project/${orgId}/${projectId}`;

  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b px-6 pb-0 pt-5">
        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-faint">
          <span>{c.domain?.label ?? "Unassigned domain"}</span>
          {c.domainState === "suggested" && <StateTag state="suggested" />}
          {c.domainState === "failed" && <StateTag state="failed" />}
          {c.domainClassifier && c.domainState !== "confirmed" && (
            <span>
              · by {c.domainClassifier}
              {c.domainConfidence != null && <span className="tnum"> {Math.round(c.domainConfidence * 100)}%</span>}
            </span>
          )}
        </div>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[22px] font-semibold leading-7 tracking-[-0.02em]">{c.label}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              <span className="font-mono">{c.key}</span>
              {c.aliases.length > 0 && (
                <span>
                  also{" "}
                  {c.aliases.map((a) => (
                    <code key={a} className="ml-1 font-mono">
                      {a}
                    </code>
                  ))}
                </span>
              )}
              {c.pinned.includes("label") && <span>name pinned</span>}
            </div>
          </div>
          <ConceptActions
            ids={ids}
            concept={{ id: c.id, label: c.label, domainId: c.domain?.id ?? null, domainState: c.domainState }}
            domains={domains}
            canEdit={canEdit}
          />
        </div>
        <nav className="mt-4 flex gap-5" aria-label="Concept sections">
          {(
            [
              ["decisions", "Decisions", c.counts.decisions + c.counts.references],
              ["contracts", "Contracts", c.counts.surfaces],
              ["sources", "Sources", null],
            ] as const
          ).map(([t, label, n]) => (
            <Link
              key={t}
              href={hrefFor({ concept: c.id, tab: t })}
              scroll={false}
              aria-current={tab === t ? "page" : undefined}
              className={cn(
                "-mb-px flex h-9 items-center gap-1.5 border-b-2 text-[13px] font-medium transition-colors duration-150",
                tab === t
                  ? "border-foreground text-foreground"
                  : "border-transparent text-faint hover:text-muted-foreground",
              )}
            >
              {label}
              {n != null && <span className="tnum text-[11px] font-normal text-faint">{n}</span>}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex-1">
        {tab === "decisions" && (
          <DecisionsTab ids={ids} base={base} conceptId={c.id} cursor={cursor} hrefFor={hrefFor} canEdit={canEdit} />
        )}
        {tab === "contracts" && (
          <ContractsTab ids={ids} base={base} conceptId={c.id} cursor={cursor} hrefFor={hrefFor} canEdit={canEdit} />
        )}
        {tab === "sources" && <SourcesTab ids={ids} base={base} conceptId={c.id} />}
      </div>
    </div>
  );
}

function Pager({ href, label = "Next page" }: { href: string | null; label?: string }) {
  if (!href) return null;
  return (
    <div className="px-6 py-3">
      <Link href={href} scroll={false} className="text-[12px] text-faint hover:text-foreground">
        {label} →
      </Link>
    </div>
  );
}

async function DecisionsTab({
  ids,
  base,
  conceptId,
  cursor,
  hrefFor,
  canEdit,
}: {
  ids: { orgId: string; projectId: string };
  base: string;
  conceptId: string;
  cursor?: string;
  hrefFor: (q: Record<string, string | undefined>) => string;
  canEdit: boolean;
}) {
  const r = await getConceptDecisions(ids.orgId, ids.projectId, conceptId, cursor);
  if (!r) return <Empty title="Couldn’t load decisions" />;
  const inConflict = new Set(
    r.conflicts.flatMap((c) => [c.constraint.id, c.engineering?.id].filter(Boolean) as string[]),
  );
  const product = r.decisions.filter((d) => d.origin === "document");
  const eng = r.decisions.filter((d) => d.origin !== "document");
  return (
    <div className="pb-6">
      {r.conflicts.length > 0 && (
        <section aria-label="Open conflicts" className="border-b px-6 py-4">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-destructive">
            {r.conflicts.length} open conflict{r.conflicts.length === 1 ? "" : "s"}
          </h3>
          <ul className="space-y-2">
            {r.conflicts.map((cf) => (
              <li key={cf.id} className="rail rail-conflict rounded-md border border-destructive-edge py-2.5 pl-4 pr-3">
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <div className="mb-0.5 text-[11px] text-faint">
                      Product constraint{cf.constraintKind ? ` · ${cf.constraintKind.replace("_", " ")}` : ""}
                    </div>
                    <Link href={`${base}/decisions/${cf.constraint.id}`} className="text-[13px] hover:underline">
                      {cf.constraint.ruleText ?? "(constraint)"}
                    </Link>
                  </div>
                  <div>
                    <div className="mb-0.5 text-[11px] text-faint">Engineering decision</div>
                    {cf.engineering ? (
                      <Link href={`${base}/decisions/${cf.engineering.id}`} className="text-[13px] hover:underline">
                        {cf.engineering.ruleText ?? "(decision)"}
                      </Link>
                    ) : (
                      <span className="text-[13px] text-faint">pending change</span>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <SurfaceId surface={cf.surface} className="text-faint" />
                  <span className="text-[11px] text-faint">{cf.kind.replace("_", " ")}</span>
                  <span className="ml-auto flex gap-1">
                    <VerdictButton
                      orgId={ids.orgId}
                      projectId={ids.projectId}
                      id={cf.id}
                      op="holds"
                      label="Constraint holds"
                    />
                    <VerdictButton
                      orgId={ids.orgId}
                      projectId={ids.projectId}
                      id={cf.id}
                      op="dismiss"
                      label="Dismiss"
                      kind="ghost"
                    />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {r.decisions.length === 0 && r.conflicts.length === 0 && (
        <Empty
          title="No decisions here yet"
          hint="Decisions scoped to this concept’s surfaces land here automatically."
        />
      )}
      {eng.length > 0 && (
        <DecisionGroup
          title="Engineering"
          rows={eng}
          ids={ids}
          base={base}
          conceptId={conceptId}
          inConflict={inConflict}
          canEdit={canEdit}
        />
      )}
      {product.length > 0 && (
        <DecisionGroup
          title="Product constraints"
          rows={product}
          ids={ids}
          base={base}
          conceptId={conceptId}
          inConflict={inConflict}
          canEdit={canEdit}
        />
      )}
      <Pager href={r.nextCursor ? hrefFor({ concept: conceptId, tab: "decisions", cursor: r.nextCursor }) : null} />
    </div>
  );
}

function DecisionGroup({
  title,
  rows,
  ids,
  base,
  conceptId,
  inConflict,
  canEdit,
}: {
  title: string;
  rows: ConceptDecision[];
  ids: { orgId: string; projectId: string };
  base: string;
  conceptId: string;
  inConflict: Set<string>;
  canEdit: boolean;
}) {
  return (
    <section className="pt-3">
      <h3 className="px-6 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">{title}</h3>
      <ul>
        {rows.map((d) => (
          <li
            key={d.id}
            tabIndex={-1}
            data-row=""
            className={cn(
              railFor(d.status, { conflict: inConflict.has(d.id) }),
              "group flex items-start gap-3 py-2 pl-6 pr-4 outline-none hover:bg-muted focus-visible:bg-muted",
            )}
          >
            <div className="min-w-0 flex-1">
              <Link
                data-row-link=""
                href={`${base}/decisions/${d.id}`}
                className="text-[13px] leading-5 text-foreground"
              >
                {d.ruleText ?? d.scopeRef}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11px] text-faint">
                <StateTag state={d.status} />
                {d.scopeKind === "surface" ? (
                  <SurfaceId surface={d.scopeRef} className="text-[11px]" />
                ) : (
                  <span>{scopeText(d.scopeKind, d.scopeLabel)}</span>
                )}
                {d.constraintKind && <span>{d.constraintKind.replace("_", " ")}</span>}
                <span className="tnum">v{d.version}</span>
                {d.impact > 0 && <span className="tnum">impact {d.impact}</span>}
                {d.via === "reference" && (
                  <span className="inline-flex items-center gap-0.5">
                    <Link2 className="h-3 w-3" /> also relevant here
                  </span>
                )}
                {d.via === "primary" && d.placement.state === "suggested" && (
                  <span className="text-warning">
                    suggested by {d.placement.classifier}
                    {d.placement.confidence != null && (
                      <span className="tnum"> {Math.round(d.placement.confidence * 100)}%</span>
                    )}
                  </span>
                )}
              </div>
            </div>
            {d.via === "primary" && (
              <div className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [&:has([data-state=open])]:opacity-100">
                <PlacementActions
                  ids={ids}
                  itemKind="decision"
                  itemId={d.id}
                  conceptId={conceptId}
                  state={d.placement.state}
                  canEdit={canEdit}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

async function ContractsTab({
  ids,
  base,
  conceptId,
  cursor,
  hrefFor,
  canEdit,
}: {
  ids: { orgId: string; projectId: string };
  base: string;
  conceptId: string;
  cursor?: string;
  hrefFor: (q: Record<string, string | undefined>) => string;
  canEdit: boolean;
}) {
  const r = await getConceptContracts(ids.orgId, ids.projectId, conceptId, cursor);
  if (!r) return <Empty title="Couldn’t load contracts" />;
  if (r.contracts.length === 0)
    return (
      <Empty title="No contracts in this concept" hint="Surfaces a repo produces are grouped here by their resource." />
    );
  return (
    <div className="pb-6">
      <div className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)] gap-4 border-b px-6 py-2 text-[11px] font-medium text-faint">
        <span>Surface</span>
        <span>Blast radius</span>
        <span>Governed by</span>
      </div>
      <ul>
        {r.contracts.map((s) => (
          <li
            key={s.id}
            tabIndex={-1}
            data-row=""
            className="group grid grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)] items-start gap-4 border-b px-6 py-2 outline-none hover:bg-muted focus-visible:bg-muted"
          >
            <div className="min-w-0">
              <SurfaceId surface={s.surface} className="block truncate text-foreground" />
              <div className="mt-0.5 flex items-center gap-2.5 text-[11px] text-faint">
                <span className="truncate">{s.repo.gitRemote?.split("/").pop() ?? "unknown repo"}</span>
                {s.returnType && <span className="font-mono">→ {s.returnType}</span>}
                <SurfaceHistory ids={ids} surfaceId={s.id} count={s.historyCount} />
                <span className="ml-auto opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <PlacementActions
                    ids={ids}
                    itemKind="surface"
                    itemId={s.id}
                    conceptId={conceptId}
                    state={s.placement.state}
                    canEdit={canEdit}
                  />
                </span>
              </div>
            </div>
            <div>
              <div className={cn("tnum text-[12px]", s.consumers.count > 0 ? "text-foreground" : "text-faint")}>
                {s.consumers.count === 0
                  ? "no consumers"
                  : `${s.consumers.count} consumer${s.consumers.count === 1 ? "" : "s"}`}
              </div>
              {s.consumers.sample.length > 0 && (
                <div className="mt-0.5 truncate text-[11px] text-faint" title={s.consumers.sample.join(", ")}>
                  {s.consumers.sample.map((x) => x.split("/").pop()).join(", ")}
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              {s.governing.length === 0 && <span className="text-[12px] text-faint">—</span>}
              {s.governing.map((g) => (
                <Link
                  key={g.id}
                  href={`${base}/decisions/${g.id}`}
                  className={cn(
                    railFor(g.status),
                    "block truncate pl-2.5 text-[12px] leading-5 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {g.ruleText ?? "(decision)"}
                </Link>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <Pager href={r.nextCursor ? hrefFor({ concept: conceptId, tab: "contracts", cursor: r.nextCursor }) : null} />
    </div>
  );
}

async function SourcesTab({
  ids,
  base,
  conceptId,
}: {
  ids: { orgId: string; projectId: string };
  base: string;
  conceptId: string;
}) {
  const r = await getConceptSources(ids.orgId, ids.projectId, conceptId);
  if (!r) return <Empty title="Couldn’t load sources" />;
  if (r.documents.length === 0 && r.provenances.length === 0) {
    return <Empty title="No sources linked" hint="PRDs and threads that produced this concept’s rules show up here." />;
  }
  return (
    <div className="space-y-6 px-6 py-4">
      {r.documents.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">Documents</h3>
          <ul className="divide-y rounded-md border">
            {r.documents.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                <FileText className="h-4 w-4 text-faint" />
                <Link href={`${base}/sources/${d.id}`} className="min-w-0 flex-1 truncate text-[13px] hover:underline">
                  {d.title ?? "(untitled)"}
                </Link>
                <span className="text-[11px] text-faint">{d.tool}</span>
                <StateTag state={d.state} />
                <span className="tnum text-[11px] text-faint">
                  {d.constraints} constraint{d.constraints === 1 ? "" : "s"}
                </span>
                {d.url && (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open source"
                    className="text-faint hover:text-foreground"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {r.provenances.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">Threads & tickets</h3>
          <ul className="space-y-1">
            {r.provenances.map((p) => (
              <li key={`${p.source}-${p.externalId}`} className="flex items-center gap-2 text-[12px]">
                <span className="w-16 text-faint">{p.source}</span>
                {p.url ? (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-muted-foreground hover:text-foreground"
                  >
                    {p.url}
                  </a>
                ) : (
                  <span className="truncate font-mono text-faint">{p.externalId}</span>
                )}
                <Link
                  href={`${base}/decisions/${p.decisionId}`}
                  className="ml-auto shrink-0 text-faint hover:text-foreground"
                >
                  decision →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
