"use client";

import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectOverview } from "../lib/types";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

const short = (r: string) => r.split("/").pop() ?? r;

// React Flow positions and paints nodes from style objects; these are data, not JSX attributes.
const consumerStyle = {
  background: "var(--muted)",
  color: "var(--foreground)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  padding: "6px 10px",
  width: 190,
};
const surfaceStyle = {
  background: "var(--card)",
  color: "var(--primary)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 11.5,
  fontFamily: "var(--font-mono, monospace)",
  padding: "6px 10px",
  width: 260,
};

/**
 * Interactive dependency graph: consumer repos (left) → produced surfaces (right), with pan / zoom /
 * fit-to-view and a text filter. The canvas starts below the filter so no node hides under it.
 */
export function DependencyGraphFlow({
  repos,
  dependencies,
}: {
  repos: ProjectOverview["repos"];
  dependencies: ProjectOverview["dependencies"];
}) {
  const [q, setQ] = useState("");
  const repoName = useMemo(() => new Map(repos.map((r) => [r.id, short(r.gitRemote)])), [repos]);

  const { nodes, edges } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const deps = dependencies.filter((d) => {
      if (!query) return true;
      const consumer = (repoName.get(d.consumerRepoId) ?? "").toLowerCase();
      const producer = d.producedRepoId ? (repoName.get(d.producedRepoId) ?? "").toLowerCase() : "";
      return consumer.includes(query) || producer.includes(query) || d.producedSurface.toLowerCase().includes(query);
    });
    const consumers = [...new Set(deps.map((d) => d.consumerRepoId))];
    const surfaces = [...new Set(deps.map((d) => d.producedSurface))];
    const GAP = 58;
    const ns: Node[] = [];
    consumers.forEach((id, i) =>
      ns.push({
        id: `c:${id}`,
        position: { x: 0, y: i * GAP },
        data: { label: repoName.get(id) ?? "consumer" },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        type: "input",
        style: consumerStyle,
      }),
    );
    surfaces.forEach((s, i) =>
      ns.push({
        id: `s:${s}`,
        position: { x: 520, y: i * GAP },
        data: { label: s },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        type: "output",
        style: surfaceStyle,
      }),
    );
    const es: Edge[] = deps.map((d, i) => ({
      id: `e:${i}:${d.consumerRepoId}:${d.producedSurface}`,
      source: `c:${d.consumerRepoId}`,
      target: `s:${d.producedSurface}`,
    }));
    return { nodes: ns, edges: es };
  }, [dependencies, q, repoName]);

  return (
    <Card className="relative mb-6 flex h-[520px] flex-col overflow-hidden shadow-none">
      <div className="flex items-center gap-2 border-b p-3">
        <Input
          placeholder="Filter by repo or surface…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-8 max-w-xs"
          aria-label="Filter dependency graph"
        />
        <span className="text-xs text-muted-foreground">
          {nodes.length} node{nodes.length === 1 ? "" : "s"} · {edges.length} edge{edges.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          minZoom={0.05}
          nodesConnectable={false}
          edgesFocusable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </Card>
  );
}
