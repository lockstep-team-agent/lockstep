"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { loadGraphAction } from "@/next-actions";
import type { GraphData } from "@/lib/next-data";
import { cn } from "@/lib/utils";

type XY = { x: number; y: number };
type GNode = GraphData["nodes"][number];
const elk = new ELK();
const DOMAIN = { w: 208, h: 56 };
const CONCEPT = { w: 176, h: 44 };
const ITEM = { w: 280, h: 60 };
// Each level gets its own region to the right of the previous one, so a level can never land on top
// of another and nothing already on screen moves when you drill in.
const REGION_GAP = 140;
const GRID = { cols: 3, dx: CONCEPT.w + 16, dy: CONCEPT.h + 14, pad: 16, header: 28 };
// decisions: engineering left, product right — a conflict (always one of each) reads as a straight line
const LIST = { dy: ITEM.h + 12, dx: ITEM.w + 72, pad: 16, header: 44 };

async function layoutDomains(ids: string[], edges: GraphData["edges"]): Promise<Map<string, XY>> {
  const set = new Set(ids);
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: ids.map((id) => ({ id, width: DOMAIN.w, height: DOMAIN.h })),
    edges: edges
      .filter((e) => set.has(e.from) && set.has(e.to))
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  });
  const out = new Map<string, XY>();
  for (const c of res.children ?? []) out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return out;
}

/** Decisions + red conflict count: the heat you can see before expanding anything. */
function Badges({ decisions, conflicts }: { decisions: number; conflicts: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px]">
      <span className="tnum text-faint" title={`${decisions} decisions`}>
        {decisions}
      </span>
      {conflicts > 0 && (
        <span
          className="tnum rounded bg-destructive-soft px-1 font-semibold text-destructive"
          title={`${conflicts} open conflicts`}
        >
          {conflicts}
        </span>
      )}
    </span>
  );
}

type ItemNode = Extract<GNode, { kind: "item" }>;
const railColor = (n: ItemNode) =>
  n.conflict ? "var(--destructive)" : n.status === "binding" ? "var(--primary)" : "var(--muted-foreground)";

/**
 * Concept graph, three levels: domains → (click) concepts → (click) that concept's decisions.
 * Domain positions are laid out once per session; each deeper level fills its own region to the
 * right. Conflicts are red edges (between decisions once a concept is open). Nothing is persisted.
 */
export function ConceptGraph({
  orgId,
  projectId,
  base,
  selected,
}: {
  orgId: string;
  projectId: string;
  base: string;
  selected?: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<GraphData | null>(null);
  const [expand, setExpand] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [show, setShow] = useState({ shared_decision: true, conflict: true });
  const [pending, start] = useTransition();
  const pos = useRef(new Map<string, XY>());
  const flow = useRef<ReactFlowInstance | null>(null);

  const load = useCallback(
    (domain?: string, concept?: string) =>
      start(async () => {
        const g = await loadGraphAction(orgId, projectId, domain, undefined, concept);
        if (!g) return;
        const domains = g.nodes.filter((n) => n.kind === "domain").map((n) => n.id);
        const newDomains = domains.filter((id) => !pos.current.has(id));
        if (newDomains.length > 0) {
          for (const [k, v] of await layoutDomains(newDomains, g.edges)) pos.current.set(k, v);
        }
        const right = Math.max(...domains.map((id) => (pos.current.get(id)?.x ?? 0) + DOMAIN.w));
        if (domain) {
          const parent = pos.current.get(`d:${domain}`) ?? { x: 0, y: 0 };
          const origin = { x: right + REGION_GAP, y: parent.y - GRID.header - GRID.pad };
          pos.current.set(`g:${domain}`, origin);
          g.nodes
            .filter((n) => n.kind === "concept")
            .forEach((n, i) =>
              pos.current.set(n.id, {
                x: origin.x + GRID.pad + (i % GRID.cols) * GRID.dx,
                y: origin.y + GRID.header + GRID.pad + Math.floor(i / GRID.cols) * GRID.dy,
              }),
            );
          const items = g.nodes.filter((n) => n.kind === "item");
          if (concept && items.length > 0) {
            const c = pos.current.get(`c:${concept}`) ?? origin;
            const gridRight = origin.x + GRID.pad * 2 + GRID.cols * GRID.dx;
            const io = { x: gridRight + REGION_GAP, y: c.y - LIST.header - LIST.pad };
            pos.current.set(`h:${concept}`, io);
            const col = [0, 0];
            for (const n of items) {
              const c = n.kind === "item" && n.origin === "document" ? 1 : 0;
              pos.current.set(n.id, {
                x: io.x + LIST.pad + c * LIST.dx,
                y: io.y + LIST.header + LIST.pad + col[c]! * LIST.dy,
              });
              col[c]!++;
            }
          }
        }
        setData(g);
      }),
    [orgId, projectId],
  );

  useEffect(() => {
    load(expand, focus);
  }, [expand, focus, load]);

  // zoom to the deepest open level; everything stays where it was — only the viewport moves
  useEffect(() => {
    if (!data) return;
    const d = data.nodes.find((n) => n.kind === "domain" && n.expanded);
    const c = data.nodes.find((n) => n.kind === "concept" && n.expanded);
    const target = c ? [{ id: `h:${c.id.slice(2)}` }] : d ? [{ id: d.id }, { id: `g:${d.id.slice(2)}` }] : undefined;
    requestAnimationFrame(() =>
      flow.current?.fitView({ duration: 200, padding: 0.12, maxZoom: 1.1, ...(target ? { nodes: target } : {}) }),
    );
  }, [data]);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const ends = { sourcePosition: Position.Right, targetPosition: Position.Left };
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const frame = (id: string, label: string, w: number, h: number, from: string) => {
      nodes.push({
        ...ends,
        id,
        position: pos.current.get(id) ?? { x: 0, y: 0 },
        selectable: false,
        zIndex: -1,
        data: {
          label: (
            <div className="text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">{label}</div>
          ),
        },
        style: {
          width: w,
          height: h,
          padding: "8px 16px",
          borderRadius: 8,
          background: "transparent",
          border: "1px dashed var(--border-strong)",
          boxShadow: "none",
          pointerEvents: "none",
        },
      });
      edges.push({
        id: `${from}->${id}`,
        source: from,
        target: id,
        style: { stroke: "var(--border-strong)", strokeWidth: 1 },
      });
    };
    const openDomain = data.nodes.find(
      (n): n is Extract<GNode, { kind: "domain" }> => n.kind === "domain" && n.expanded,
    );
    const concepts = data.nodes.filter((n): n is Extract<GNode, { kind: "concept" }> => n.kind === "concept");
    const items = data.nodes.filter((n): n is ItemNode => n.kind === "item");
    const openConcept = concepts.find((c) => c.expanded);
    if (openDomain && concepts.length > 0) {
      const rowsN = Math.ceil(concepts.length / GRID.cols);
      frame(
        `g:${openDomain.id.slice(2)}`,
        openDomain.label,
        GRID.pad * 2 + Math.min(concepts.length, GRID.cols) * GRID.dx - 16,
        GRID.header + GRID.pad * 2 + rowsN * GRID.dy - 14,
        openDomain.id,
      );
    }
    if (openConcept && items.length > 0) {
      const product = items.filter((i) => i.origin === "document").length;
      const tallest = Math.max(product, items.length - product);
      frame(
        `h:${openConcept.id.slice(2)}`,
        `${openConcept.label} — engineering  ·  product`,
        LIST.pad * 2 + ITEM.w + (product > 0 ? LIST.dx : 0),
        LIST.header + LIST.pad * 2 + tallest * LIST.dy - 12,
        openConcept.id,
      );
    }
    // Several concepts can share a label ("files" over http and gql): add the protocol to tell them apart.
    const labelCount = new Map<string, number>();
    for (const n of data.nodes) if (n.kind === "concept") labelCount.set(n.label, (labelCount.get(n.label) ?? 0) + 1);
    const shown = (n: (typeof data.nodes)[number]) => {
      const key = (n as { key?: string }).key;
      return n.kind === "concept" && (labelCount.get(n.label) ?? 0) > 1 && key?.includes(":") ? `${n.label} · ${key.split(":")[0]}` : n.label;
    };
    for (const n of data.nodes) {
      const p = pos.current.get(n.id) ?? { x: 0, y: 0 };
      if (n.kind === "item") {
        nodes.push({
          ...ends,
          id: n.id,
          position: p,
          data: {
            label: (
              <div className="text-left">
                <div className="line-clamp-2 text-[11px] leading-4 text-foreground">{n.label}</div>
                <div className={cn("mt-0.5 text-[10px]", n.conflict ? "text-destructive" : "text-faint")}>
                  {n.conflict ? "in conflict · " : ""}
                  {n.status}
                  {n.origin === "document" ? " · product" : ""}
                </div>
              </div>
            ),
          },
          style: {
            width: ITEM.w,
            height: ITEM.h,
            overflow: "hidden",
            padding: "6px 10px 6px 12px",
            borderRadius: 6,
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderLeft: `2px solid ${railColor(n)}`,
            color: "var(--foreground)",
            boxShadow: "none",
          },
        });
        continue;
      }
      const isDomain = n.kind === "domain";
      const active = !isDomain && (n.expanded || (selected && n.id === `c:${selected}`));
      nodes.push({
        ...ends,
        id: n.id,
        position: p,
        data: {
          label: (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-left",
                  isDomain ? "text-[13px] font-semibold" : "text-[12px]",
                )}
              >
                {shown(n)}
              </span>
              <Badges decisions={n.decisions} conflicts={n.conflicts} />
            </div>
          ),
        },
        style: {
          width: isDomain ? DOMAIN.w : CONCEPT.w,
          padding: isDomain ? "14px 12px" : "10px 10px",
          borderRadius: 6,
          background: isDomain ? "var(--card)" : "var(--background)",
          border: `1px solid ${active ? "var(--primary)" : n.expanded ? "var(--border-strong)" : n.conflicts > 0 ? "var(--destructive-edge)" : "var(--border)"}`,
          color: "var(--foreground)",
          boxShadow: "none",
        },
      });
    }
    const origin = new Map(items.map((i) => [i.id, i.origin]));
    for (const e of data.edges.filter((x) => show[x.kind])) {
      // between two decisions, always draw left (engineering) → right (product)
      const flip =
        e.kind === "conflict" &&
        origin.get(e.from) === "document" &&
        origin.has(e.to) &&
        origin.get(e.to) !== "document";
      edges.push({
        id: `${e.from}-${e.to}-${e.kind}`,
        source: flip ? e.to : e.from,
        target: flip ? e.from : e.to,
        type: origin.has(e.from) && origin.has(e.to) ? "straight" : undefined,
        label: e.weight > 1 ? String(e.weight) : undefined,
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
        labelBgStyle: { fill: "var(--background)" },
        style: {
          stroke: e.kind === "conflict" ? "var(--destructive)" : "var(--border-strong)",
          strokeWidth: Math.min(4, 1 + Math.log2(e.weight)),
          strokeDasharray: e.kind === "shared_decision" ? "4 3" : undefined,
        },
        markerEnd:
          e.kind === "conflict" && !(origin.has(e.from) && origin.has(e.to))
            ? { type: MarkerType.ArrowClosed, color: "var(--destructive)" }
            : undefined,
      });
    }
    return { nodes, edges };
  }, [data, show, selected]);

  const onNodeClick: NodeMouseHandler = (_, n) => {
    const kind = n.id.slice(0, 1);
    const id = n.id.slice(2);
    if (kind === "d") {
      setFocus(undefined);
      setExpand((cur) => (cur === id ? undefined : id));
    } else if (kind === "c") setFocus((cur) => (cur === id ? undefined : id));
    else if (kind === "i") router.push(`${base}/decisions/${id}`);
  };
  const onNodeDoubleClick: NodeMouseHandler = (_, n) => {
    // Opening a concept is explicit intent to read its ledger: say so, so a saved graph
    // preference can't bounce the user back into the graph (review D1).
    if (n.id.startsWith("c:")) router.push(`${base}/map?concept=${n.id.slice(2)}&view=outline`);
  };

  return (
    <div className="concept-graph relative h-full min-h-[480px]">
      <div className="absolute left-3 top-3 z-10 flex items-center gap-3 rounded-md border bg-card px-3 py-1.5 text-[12px]">
        {(
          [
            ["shared_decision", "Shared decision", "border-t border-dashed border-muted-foreground"],
            ["conflict", "Conflict", "border-t-2 border-destructive"],
          ] as const
        ).map(([k, label, line]) => (
          <label key={k} className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={show[k]}
              onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))}
              className="accent-[var(--primary)]"
            />
            <span className={cn("inline-block w-4", line)} />
            {label}
          </label>
        ))}
        <span className="flex items-center gap-1 text-faint">
          <span className="tnum">n</span> decisions ·
          <span className="rounded bg-destructive-soft px-1 text-destructive">n</span> open conflicts
        </span>
        {pending && <span className="text-faint">loading…</span>}
        {data?.truncated && <span className="text-warning">showing the 500 heaviest edges</span>}
      </div>
      <div className="absolute right-3 top-3 z-10 max-w-[260px] rounded-md border bg-card px-3 py-1.5 text-[11px] text-faint">
        Click a domain, then a concept, to see its decisions; click a decision to review it. Double-click a concept to
        open it. Concept dependencies aren’t drawn: consumers are tracked per repo, not per surface.
      </div>
      {data && data.nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">No domains yet.</div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onInit={(i) => (flow.current = i)}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          fitView
          minZoom={0.15}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
      {data?.nextCursor && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-md border bg-card px-3 py-1.5 text-[12px] text-faint">
          Showing the first 50 concepts of this domain. Use the outline for the rest.
        </div>
      )}
    </div>
  );
}
