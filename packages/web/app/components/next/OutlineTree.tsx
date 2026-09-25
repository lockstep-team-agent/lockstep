"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronRight, Globe2, Inbox as InboxIcon, Shapes } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Outline, OutlineConcept } from "@/lib/next-data";
import { loadDomainPageAction, loadGroupPageAction } from "@/next-actions";

type Props = {
  orgId: string;
  projectId: string;
  outline: Outline;
  selected: { concept?: string; group?: string };
  mapHref: string;
  view?: string;
};

/** Domain → Concept outline. Bounded pages from the server; "load more" follows each cursor. */
export function OutlineTree({ orgId, projectId, outline, selected, mapHref, view }: Props) {
  const hrefFor = (q: Record<string, string>) =>
    `${mapHref}?${new URLSearchParams({ ...q, ...(view ? { view } : {}) })}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<Record<string, { concepts: OutlineConcept[]; cursor: string | null }>>({});
  const [unassigned, setUnassigned] = useState<{ concepts: OutlineConcept[]; cursor: string | null } | null>(null);
  const [filter, setFilter] = useState("");
  const [pending, start] = useTransition();
  const f = filter.trim().toLowerCase();
  const match = (c: OutlineConcept) => !f || c.label.toLowerCase().includes(f) || c.key.toLowerCase().includes(f);

  const domains = useMemo(
    () =>
      outline.domains.map((d) => {
        const more = extra[d.id];
        return {
          ...d,
          concepts: [...d.concepts, ...(more?.concepts ?? [])],
          cursor: more ? more.cursor : d.nextCursor,
        };
      }),
    [outline, extra],
  );

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const loadMore = (domainId: string, cursor: string) =>
    start(async () => {
      const r = await loadDomainPageAction(orgId, projectId, domainId, cursor);
      if (!r) return;
      setExtra((e) => ({
        ...e,
        [domainId]: { concepts: [...(e[domainId]?.concepts ?? []), ...r.concepts], cursor: r.nextCursor },
      }));
    });

  const loadUnassigned = (cursor?: string) =>
    start(async () => {
      const r = await loadGroupPageAction(orgId, projectId, "unassigned_domain", cursor);
      if (!r || r.kind !== "concepts") return;
      setUnassigned((u) => ({
        concepts: [...(cursor ? (u?.concepts ?? []) : []), ...r.concepts],
        cursor: r.nextCursor,
      }));
    });

  const empty =
    outline.domains.every((d) => d.counts.concepts === 0) && outline.groups.unassigned_domain.concepts === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter concepts"
          aria-label="Filter concepts"
          className="h-7 w-full rounded-md border bg-muted px-2 text-[12px] outline-none placeholder:text-faint focus:border-border-strong"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-6" role="tree" aria-label="Concepts by domain">
        {empty && (
          <p className="px-4 py-6 text-[12px] leading-5 text-faint">
            No concepts yet. They appear as soon as a repo syncs its surfaces (
            <code className="font-mono">lockstep scan --apply</code>).
          </p>
        )}
        {domains.map((d) => {
          const open = !collapsed.has(d.id);
          const list = d.concepts.filter(match);
          if (d.counts.concepts === 0 && !f) return null;
          if (f && list.length === 0) return null;
          return (
            <div key={d.id} role="treeitem" aria-expanded={open} aria-selected={false}>
              <button
                type="button"
                onClick={() => toggle(d.id)}
                className="group flex h-7 w-full items-center gap-1.5 px-3 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-faint hover:text-muted-foreground"
              >
                <ChevronRight className={cn("h-3 w-3 transition-transform duration-150", open && "rotate-90")} />
                <span className="flex-1 truncate">{d.label}</span>
                {d.counts.conflicts > 0 && <span className="tnum text-destructive">{d.counts.conflicts}</span>}
                <span className="tnum font-medium normal-case tracking-normal">{d.counts.concepts}</span>
              </button>
              {open && (
                <div role="group">
                  {list.map((c) => (
                    <ConceptRow key={c.id} c={c} active={selected.concept === c.id} href={hrefFor({ concept: c.id })} />
                  ))}
                  {d.cursor && !f && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => loadMore(d.id, d.cursor!)}
                      className="ml-7 h-7 text-[12px] text-faint hover:text-foreground disabled:opacity-50"
                    >
                      Show {Math.min(100, d.counts.concepts - d.concepts.length)} more…
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-3 border-t pt-2">
          {outline.groups.unassigned_domain.concepts > 0 && (
            <div>
              <button
                type="button"
                onClick={() => (unassigned ? setUnassigned(null) : loadUnassigned())}
                className="flex h-7 w-full items-center gap-2 px-3 text-left text-[12px] text-muted-foreground hover:text-foreground"
              >
                <Shapes className="h-3.5 w-3.5 text-faint" />
                <span className="flex-1">Unassigned domain</span>
                <span className="tnum text-faint">{outline.groups.unassigned_domain.concepts}</span>
              </button>
              {unassigned && (
                <div>
                  {unassigned.concepts.filter(match).map((c) => (
                    <ConceptRow key={c.id} c={c} active={selected.concept === c.id} href={hrefFor({ concept: c.id })} />
                  ))}
                  {unassigned.cursor && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => loadUnassigned(unassigned.cursor!)}
                      className="ml-7 h-7 text-[12px] text-faint hover:text-foreground"
                    >
                      Show more…
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <GroupRow
            icon={<Globe2 className="h-3.5 w-3.5 text-faint" />}
            label="Project-wide"
            n={outline.groups.project_wide.items}
            href={hrefFor({ group: "project_wide" })}
            active={selected.group === "project_wide"}
          />
          <GroupRow
            icon={<InboxIcon className="h-3.5 w-3.5 text-faint" />}
            label="Needs placement"
            n={outline.groups.unplaced.items}
            href={hrefFor({ group: "unplaced" })}
            active={selected.group === "unplaced"}
            warn
          />
        </div>
      </div>
    </div>
  );
}

const kindOf = (key: string) => /^([a-z][a-z0-9_-]*):/.exec(key)?.[1] ?? "other";

function ConceptRow({ c, active, href }: { c: OutlineConcept; active: boolean; href: string }) {
  return (
    <Link
      href={href}
      scroll={false}
      data-row=""
      data-row-link=""
      role="treeitem"
      aria-selected={active}
      className={cn(
        "group relative flex h-8 items-center gap-2 pl-7 pr-3 text-[13px] outline-none transition-colors duration-100",
        "hover:bg-muted focus-visible:bg-muted",
        active
          ? "bg-muted text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded before:bg-primary"
          : "text-muted-foreground",
      )}
    >
      <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>
        {c.label}
        {/* kinds never auto-merge, so "orders" can exist as http and event: name the non-http ones */}
        {kindOf(c.key) !== "http" && <span className="ml-1.5 font-mono text-[10px] text-faint">{kindOf(c.key)}</span>}
      </span>
      {c.counts.conflicts > 0 && (
        <span aria-label={`${c.counts.conflicts} conflicts`} className="h-1.5 w-1.5 rounded-full bg-destructive" />
      )}
      {c.counts.suggested > 0 && (
        <span aria-label="has placements to review" className="h-1.5 w-1.5 rounded-full bg-warning" />
      )}
      <span className="tnum shrink-0 text-[11px] text-faint">
        {c.counts.surfaces}
        <span className="mx-0.5 opacity-50">·</span>
        {c.counts.decisions}
      </span>
    </Link>
  );
}

function GroupRow({
  icon,
  label,
  n,
  href,
  active,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  n: number;
  href: string;
  active: boolean;
  warn?: boolean;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      data-row=""
      data-row-link=""
      className={cn(
        "flex h-7 items-center gap-2 px-3 text-[12px] outline-none hover:bg-muted focus-visible:bg-muted",
        active ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className={cn("tnum", warn && n > 0 ? "text-warning" : "text-faint")}>{n}</span>
    </Link>
  );
}
