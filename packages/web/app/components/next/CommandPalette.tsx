"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { BarChart3, Inbox, Network, Rows3, Settings2, Search, Moon, CircleDot, Braces, ScrollText } from "lucide-react";
import { searchAction } from "@/next-actions";
import type { SearchResult } from "@/lib/next-data";
import { toggleTheme } from "./ThemeToggle";

const EMPTY: SearchResult = { concepts: [], surfaces: [], decisions: [] };

export function openPalette(): void {
  window.dispatchEvent(new Event("lockstep:palette"));
}

/** ⌘K: jump to any concept, surface or decision, or run an action. Server-side search, no filtering here. */
export function CommandPalette({ orgId, projectId, base }: { orgId: string; projectId: string; base: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult>(EMPTY);
  // cmdk won't pick a first item for async (unfiltered) results, so Enter would do nothing
  const [sel, setSel] = useState("");
  const [, start] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("lockstep:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("lockstep:palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const t = setTimeout(
      () => {
        start(async () => {
          const r = await searchAction(orgId, projectId, q);
          if (n === seq.current) {
            const next = r ?? EMPTY;
            setRes(next);
            const first = next.concepts[0]
              ? `c-${next.concepts[0].id}`
              : next.surfaces[0]
                ? `s-${next.surfaces[0].id}`
                : next.decisions[0]
                  ? `d-${next.decisions[0].id}`
                  : q
                    ? (() => {
                        const nav = ["inbox", "map", "ledger", "insights", "settings"].find((x) =>
                          x.includes(q.trim().toLowerCase()),
                        );
                        return nav ? `go-${nav}` : "";
                      })()
                    : "go-inbox";
            setSel(first);
          }
        });
      },
      q ? 120 : 0,
    );
    return () => clearTimeout(t);
  }, [q, open, orgId, projectId]);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };
  const concept = (id: string | null) => (id ? `${base}/map?concept=${id}` : `${base}/map`);
  const item =
    "flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground data-[selected=true]:bg-muted data-[selected=true]:text-foreground";
  const group =
    "px-1 pb-1 pt-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[14vh] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-raised shadow-[0_0_0_1px_rgba(0,0,0,.2),0_24px_48px_-12px_rgba(0,0,0,.5)]"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command shouldFilter={false} loop value={sel} onValueChange={setSel}>
            <div className="flex items-center gap-2.5 border-b px-3.5">
              <Search className="h-4 w-4 text-faint" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search concepts, surfaces, decisions…"
                className="h-12 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <kbd className="font-mono text-[10px] text-faint">ESC</kbd>
            </div>
            <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto px-1.5 pb-1.5">
              <Command.Empty className="px-3 py-8 text-center text-[13px] text-faint">
                Nothing matches “{q}”.
              </Command.Empty>
              {res.concepts.length > 0 && (
                <Command.Group heading="Concepts" className={group}>
                  {res.concepts.map((c) => (
                    <Command.Item key={c.id} value={`c-${c.id}`} onSelect={() => go(concept(c.id))} className={item}>
                      <CircleDot className="h-3.5 w-3.5 text-faint" />
                      <span className="text-foreground">{c.label}</span>
                      <span className="ml-auto font-mono text-[11px] text-faint">{c.key}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {res.surfaces.length > 0 && (
                <Command.Group heading="Surfaces" className={group}>
                  {res.surfaces.map((s) => (
                    <Command.Item
                      key={s.id}
                      value={`s-${s.id}`}
                      onSelect={() =>
                        go(
                          s.conceptId
                            ? `${base}/map?concept=${s.conceptId}&tab=contracts`
                            : `${base}/ledger?tab=contracts&q=${encodeURIComponent(s.surface)}`,
                        )
                      }
                      className={item}
                    >
                      <Braces className="h-3.5 w-3.5 text-faint" />
                      <span className="truncate font-mono text-[12px] text-foreground">{s.surface}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {res.decisions.length > 0 && (
                <Command.Group heading="Decisions" className={group}>
                  {res.decisions.map((d) => (
                    <Command.Item
                      key={d.id}
                      value={`d-${d.id}`}
                      onSelect={() => go(`${base}/decisions/${d.id}`)}
                      className={item}
                    >
                      <ScrollText className="h-3.5 w-3.5 text-faint" />
                      <span className="truncate text-foreground">{d.ruleText}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-faint">{d.status}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {(res.standards?.length ?? 0) > 0 && (
                <Command.Group heading="Standards & skills" className={group}>
                  {res.standards!.map((x) => (
                    <Command.Item
                      key={x.id}
                      value={`x-${x.id}`}
                      onSelect={() => go(`/org/${orgId}/standards/${x.id}`)}
                      className={item}
                    >
                      <ScrollText className="h-3.5 w-3.5 text-faint" />
                      <span className="truncate text-foreground">{x.name}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-faint">{x.kind}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {(() => {
                // Navigation stays searchable alongside server results ("settings" finds Settings).
                const t = q.trim().toLowerCase();
                const nav = [
                  { label: "Inbox", seg: "inbox", icon: Inbox, k: "G I" },
                  { label: "Map", seg: "map", icon: Network, k: "G M" },
                  { label: "Ledger", seg: "ledger", icon: Rows3, k: "G L" },
                  { label: "Insights", seg: "insights", icon: BarChart3, k: "G N" },
                  { label: "Settings", seg: "settings", icon: Settings2, k: "G S" },
                ].filter((x) => !t || x.label.toLowerCase().includes(t));
                const theme = !t || "toggle theme dark light".includes(t);
                if (!nav.length && !theme) return null;
                return (
                  <Command.Group heading="Go to" className={group}>
                    {nav.map(({ label, seg, icon: Icon, k }) => (
                      <Command.Item
                        key={seg}
                        value={`go-${seg}`}
                        onSelect={() => go(`${base}/${seg}`)}
                        className={item}
                      >
                        <Icon className="h-3.5 w-3.5 text-faint" />
                        <span className="text-foreground">{label}</span>
                        <kbd className="ml-auto font-mono text-[10px] text-faint">{k}</kbd>
                      </Command.Item>
                    ))}
                    {theme && (
                      <Command.Item
                        value="theme"
                        onSelect={() => {
                          toggleTheme();
                          setOpen(false);
                        }}
                        className={item}
                      >
                        <Moon className="h-3.5 w-3.5 text-faint" />
                        <span className="text-foreground">Toggle theme</span>
                      </Command.Item>
                    )}
                  </Command.Group>
                );
              })()}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
