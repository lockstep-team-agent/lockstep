"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Check, ChevronDown, GitMerge, MoveRight, Pencil, Pin, History } from "lucide-react";
import {
  loadSurfaceHistoryAction,
  mergeConceptAction,
  placeItemAction,
  renameConceptAction,
  searchAction,
  setConceptDomainAction,
  type ActionResult,
} from "@/next-actions";
import type { SurfaceChange } from "@/lib/next-data";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { btn } from "./bits";

type Ids = { orgId: string; projectId: string };

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "failed");
      else router.refresh();
    });
  return { pending, error, run };
}

/** Pick a concept (server search). Used for "move to" and "merge into". */
export function ConceptPicker({
  ids,
  open,
  onOpenChange,
  title,
  exclude,
  onPick,
}: {
  ids: Ids;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  exclude?: string;
  onPick: (conceptId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Array<{ id: string; label: string; key: string }>>([]);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await searchAction(ids.orgId, ids.projectId, q);
      if (n === seq.current) setItems((r?.concepts ?? []).filter((c) => c.id !== exclude));
    }, 100);
    return () => clearTimeout(t);
  }, [q, open, ids.orgId, ids.projectId, exclude]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-[18vh] z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-raised shadow-[0_24px_48px_-12px_rgba(0,0,0,.5)]">
          <Dialog.Title className="border-b px-3.5 py-2.5 text-[12px] font-medium text-muted-foreground">
            {title}
          </Dialog.Title>
          <Command shouldFilter={false} loop>
            <Command.Input
              value={q}
              onValueChange={setQ}
              autoFocus
              placeholder="Search concepts…"
              className="h-10 w-full border-b bg-transparent px-3.5 text-[13px] outline-none placeholder:text-faint focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Command.List className="max-h-72 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[12px] text-faint">No concepts match.</Command.Empty>
              {items.map((c) => (
                <Command.Item
                  key={c.id}
                  value={c.id}
                  onSelect={() => {
                    onPick(c.id);
                    onOpenChange(false);
                  }}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-[13px] data-[selected=true]:bg-muted"
                >
                  <span>{c.label}</span>
                  <span className="ml-auto font-mono text-[11px] text-faint">{c.key}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Concept header edits: rename (pins label), domain (pins domain), merge (alias). */
export function ConceptActions({
  ids,
  concept,
  domains,
  canEdit,
}: {
  ids: Ids;
  concept: { id: string; label: string; domainId: string | null; domainState: string };
  domains: Array<{ id: string; label: string }>;
  canEdit: boolean;
}) {
  const { pending, error, run } = useAct();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(concept.label);
  const [merging, setMerging] = useState(false);
  if (!canEdit) return null;
  return (
    <div className="flex items-center gap-1">
      {concept.domainState === "suggested" && concept.domainId && (
        <button
          type="button"
          disabled={pending}
          className={btn.primary}
          onClick={() => run(() => setConceptDomainAction(ids.orgId, ids.projectId, concept.id, concept.domainId!))}
        >
          <Check className="h-3.5 w-3.5" /> Confirm domain
        </button>
      )}
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setRenaming(false);
            if (label.trim() && label !== concept.label)
              run(() => renameConceptAction(ids.orgId, ids.projectId, concept.id, label));
          }}
          className="flex items-center gap-1"
        >
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
            aria-label="Concept name"
            className="h-7 w-48 rounded-md border bg-muted px-2 text-[13px] outline-none focus:border-border-strong"
          />
          <button type="submit" className={btn.outline}>
            Save
          </button>
        </form>
      ) : (
        <button type="button" className={btn.ghost} onClick={() => setRenaming(true)}>
          <Pencil className="h-3.5 w-3.5" /> Rename
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={btn.ghost} disabled={pending}>
          <MoveRight className="h-3.5 w-3.5" /> Domain <ChevronDown className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
          <DropdownMenuLabel className="text-[11px] font-medium text-faint">Move to domain</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {domains.map((d) => (
            <DropdownMenuItem
              key={d.id}
              className="text-[13px]"
              onSelect={() => run(() => setConceptDomainAction(ids.orgId, ids.projectId, concept.id, d.id))}
            >
              <span className="flex-1">{d.label}</span>
              {d.id === concept.domainId && <Check className="h-3.5 w-3.5 text-primary-ink" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" className={btn.ghost} onClick={() => setMerging(true)}>
        <GitMerge className="h-3.5 w-3.5" /> Merge
      </button>
      <ConceptPicker
        ids={ids}
        open={merging}
        onOpenChange={setMerging}
        title={`Merge “${concept.label}” into…`}
        exclude={concept.id}
        onPick={(into) => run(() => mergeConceptAction(ids.orgId, ids.projectId, concept.id, into))}
      />
      {error && (
        <span role="alert" className="text-[12px] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

/** Confirm a suggested placement, move it, or pin it project-wide. Pins the location only. */
export function PlacementActions({
  ids,
  itemKind,
  itemId,
  conceptId,
  state,
  canEdit,
}: {
  ids: Ids;
  itemKind: "surface" | "decision";
  itemId: string;
  conceptId: string | null;
  state: string | null;
  canEdit: boolean;
}) {
  const { pending, error, run } = useAct();
  const [moving, setMoving] = useState(false);
  if (!canEdit) return null;
  return (
    <span className="flex items-center gap-0.5">
      {state === "suggested" && conceptId && (
        <button
          type="button"
          disabled={pending}
          className={btn.ghost}
          title="Confirm this placement"
          onClick={() => run(() => placeItemAction(ids.orgId, ids.projectId, itemKind, itemId, { conceptId }))}
        >
          <Check className="h-3.5 w-3.5 text-primary-ink" /> Confirm
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={btn.ghost} aria-label="Placement options" disabled={pending}>
          <Pin className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem className="text-[13px]" onSelect={() => setMoving(true)}>
            Move to concept…
          </DropdownMenuItem>
          {itemKind === "decision" && (
            <DropdownMenuItem
              className="text-[13px]"
              onSelect={() =>
                run(() => placeItemAction(ids.orgId, ids.projectId, itemKind, itemId, { projectWide: true }))
              }
            >
              Mark project-wide
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConceptPicker
        ids={ids}
        open={moving}
        onOpenChange={setMoving}
        title="Move to concept…"
        exclude={conceptId ?? undefined}
        onPick={(to) => run(() => placeItemAction(ids.orgId, ids.projectId, itemKind, itemId, { conceptId: to }))}
      />
      {error && (
        <span role="alert" className="text-[11px] text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** Contract change history, loaded on demand. */
export function SurfaceHistory({ ids, surfaceId, count }: { ids: Ids; surfaceId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SurfaceChange[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const load = (c?: string) =>
    start(async () => {
      const r = await loadSurfaceHistoryAction(ids.orgId, ids.projectId, surfaceId, c);
      if (!r) return;
      setRows((x) => [...(c ? (x ?? []) : []), ...r.history]);
      setCursor(r.nextCursor);
    });
  return (
    <div>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-foreground"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!rows) load();
        }}
      >
        <History className="h-3 w-3" /> {count} change{count === 1 ? "" : "s"}
      </button>
      {open && (
        <ol className="mt-1.5 space-y-1 border-l pl-3">
          {pending && !rows && <li className="text-[11px] text-faint">Loading…</li>}
          {rows?.map((h) => (
            <li key={h.id} className="text-[11px] text-muted-foreground">
              <span className="tnum text-faint">{new Date(h.createdAt).toISOString().slice(0, 10)}</span>{" "}
              {h.delta ? (
                <code className="font-mono">{JSON.stringify(h.delta).slice(0, 140)}</code>
              ) : (
                <span className="text-faint">registered ({h.verifiedAgainst ?? "asserted"})</span>
              )}
            </li>
          ))}
          {cursor && (
            <li>
              <button
                type="button"
                disabled={pending}
                onClick={() => load(cursor)}
                className="text-[11px] text-faint hover:text-foreground"
              >
                Older…
              </button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
