import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { Me } from "@/lib/types";
import { getOutline, getOutlineGroup, newUiEnabled } from "@/lib/next-data";
import { OutlineTree } from "@/components/next/OutlineTree";
import { ConceptPane } from "@/components/next/ConceptPane";
import { ViewToggle } from "@/components/next/ViewToggle";
import { PlacementActions } from "@/components/next/ConceptControls";
import { ConceptGraphLazy as ConceptGraph } from "@/components/next/ConceptGraphLazy";
import { Empty, PageHead, StateTag } from "@/components/next/bits";

export const dynamic = "force-dynamic";

type SP = { concept?: string; tab?: string; cursor?: string; group?: string; view?: string };
const TABS = ["decisions", "contracts", "sources"] as const;

export default async function MapPage({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: SP;
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  if (!newUiEnabled()) redirect(base);
  const [outline, me] = await Promise.all([getOutline(orgId, projectId), apiGet<Me>("/me")]);
  if (!outline) return <Empty title="Couldn’t load the map" hint="The API didn’t respond. Try again in a moment." />;

  const view = searchParams.view === "graph" ? "graph" : "outline";
  const tab = TABS.find((t) => t === searchParams.tab) ?? "decisions";
  const canEdit = ["owner", "pm"].includes(outline.viewer.role);
  const domains = outline.domains.map((d) => ({ id: d.id, label: d.label }));
  const hrefFor = (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...q, view: view === "graph" ? "graph" : undefined })) if (v) p.set(k, v);
    return `${base}/map?${p}`;
  };
  const totals = outline.domains.reduce(
    (a, d) => ({ concepts: a.concepts + d.counts.concepts, items: a.items + d.counts.items }),
    { concepts: 0, items: 0 },
  );

  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title="Map"
        meta={
          <span className="tnum">
            {totals.concepts} concepts · {totals.items} items
          </span>
        }
        actions={<ViewToggle user={me?.principal.githubLogin ?? "me"} projectId={projectId} view={view} />}
      />
      <div className="flex min-h-0 flex-1">
        <div className="w-[300px] shrink-0 border-r">
          <OutlineTree
            orgId={orgId}
            projectId={projectId}
            outline={outline}
            selected={{ concept: searchParams.concept, group: searchParams.group }}
            mapHref={`${base}/map`}
            view={view === "graph" ? "graph" : undefined}
          />
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {view === "graph" ? (
            <ConceptGraph orgId={orgId} projectId={projectId} base={base} selected={searchParams.concept} />
          ) : searchParams.concept ? (
            <ConceptPane
              orgId={orgId}
              projectId={projectId}
              conceptId={searchParams.concept}
              tab={tab}
              cursor={searchParams.cursor}
              hrefFor={hrefFor}
              domains={domains}
              canEdit={canEdit}
            />
          ) : searchParams.group === "project_wide" || searchParams.group === "unplaced" ? (
            <GroupPane
              orgId={orgId}
              projectId={projectId}
              group={searchParams.group}
              cursor={searchParams.cursor}
              base={base}
              hrefFor={hrefFor}
              canEdit={canEdit}
            />
          ) : (
            <Overview outline={outline} hrefFor={hrefFor} />
          )}
        </div>
      </div>
    </div>
  );
}

async function GroupPane({
  orgId,
  projectId,
  group,
  cursor,
  base,
  hrefFor,
  canEdit,
}: {
  orgId: string;
  projectId: string;
  group: "project_wide" | "unplaced";
  cursor?: string;
  base: string;
  hrefFor: (q: Record<string, string | undefined>) => string;
  canEdit: boolean;
}) {
  const r = await getOutlineGroup(orgId, projectId, group, cursor);
  const title = group === "project_wide" ? "Project-wide" : "Needs placement";
  const hint =
    group === "project_wide"
      ? "Rules scoped to the whole project. They apply everywhere, so they don’t belong to one concept."
      : "Items the rules couldn’t place and the classifier hasn’t placed yet, or couldn’t. Move each one to a concept.";
  if (!r || r.kind !== "items") return <Empty title={`Couldn’t load ${title}`} />;
  return (
    <div className="pb-6">
      <div className="border-b px-6 py-5">
        <h2 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h2>
        <p className="mt-1 max-w-xl text-[12px] text-faint">{hint}</p>
      </div>
      {r.items.length === 0 && <Empty title="Nothing here" />}
      <ul>
        {r.items.map((i) => (
          <li
            key={i.itemId}
            tabIndex={-1}
            data-row=""
            className="group flex items-start gap-3 py-2 pl-6 pr-4 outline-none hover:bg-muted focus-visible:bg-muted"
          >
            <div className="min-w-0 flex-1">
              {i.itemKind === "decision" ? (
                <Link data-row-link="" href={`${base}/decisions/${i.itemId}`} className="text-[13px]">
                  {i.title}
                </Link>
              ) : (
                <span className="font-mono text-[12px]">{i.title}</span>
              )}
              <div className="mt-0.5 flex gap-2 text-[11px] text-faint">
                {i.status && <StateTag state={i.status} />}
                <StateTag state={i.state} />
                {i.lastError && (
                  <span>
                    {i.lastError === "no_provider" ? "no classifier configured" : i.lastError.replace("_", " ")}
                  </span>
                )}
              </div>
            </div>
            <PlacementActions
              ids={{ orgId, projectId }}
              itemKind={i.itemKind === "surface" ? "surface" : "decision"}
              itemId={i.itemId}
              conceptId={null}
              state={i.state}
              canEdit={canEdit}
            />
          </li>
        ))}
      </ul>
      {r.nextCursor && (
        <div className="px-6 py-3">
          <Link
            href={hrefFor({ group, cursor: r.nextCursor })}
            className="text-[12px] text-faint hover:text-foreground"
          >
            Next page →
          </Link>
        </div>
      )}
    </div>
  );
}

function Overview({
  outline,
  hrefFor,
}: {
  outline: NonNullable<Awaited<ReturnType<typeof getOutline>>>;
  hrefFor: (q: Record<string, string | undefined>) => string;
}) {
  const hot = outline.domains
    .flatMap((d) => d.concepts.map((c) => ({ ...c, domain: d.label })))
    .filter((c) => c.counts.conflicts > 0 || c.counts.suggested > 0)
    .sort((a, b) => b.counts.conflicts - a.counts.conflicts || b.counts.suggested - a.counts.suggested)
    .slice(0, 8);
  const domains = outline.domains.filter((d) => d.counts.concepts > 0);
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Every rule, filed where it applies.</h2>
      <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
        Concepts group each surface with the engineering decisions and product constraints about it. Pick one on the
        left, or start with what needs attention.
      </p>
      {hot.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">Needs attention</h3>
          <ul className="divide-y rounded-md border">
            {hot.map((c) => (
              <li key={c.id}>
                <Link
                  href={hrefFor({ concept: c.id })}
                  className="flex h-9 items-center gap-3 px-3 text-[13px] hover:bg-muted"
                >
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-[11px] text-faint">{c.domain}</span>
                  {c.counts.conflicts > 0 && (
                    <span className="tnum text-[12px] text-destructive">
                      {c.counts.conflicts} conflict{c.counts.conflicts === 1 ? "" : "s"}
                    </span>
                  )}
                  {c.counts.suggested > 0 && (
                    <span className="tnum text-[12px] text-warning">{c.counts.suggested} to review</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {domains.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">Domains</h3>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-3">
            {domains.map((d) => (
              <div key={d.id} className="bg-background px-3 py-3">
                <div className="text-[13px] font-medium">{d.label}</div>
                <div className="tnum mt-0.5 text-[12px] text-faint">
                  {d.counts.concepts} concepts · {d.counts.items} items
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
