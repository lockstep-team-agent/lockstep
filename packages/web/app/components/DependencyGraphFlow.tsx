"use client";

import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ProjectOverview } from "../lib/types";

const short = (r: string) => r.split("/").pop() ?? r;

const consumerStyle = {
  background: "var(--surface-3)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 12,
  padding: "6px 10px",
  width: 190,
};
const surfaceStyle = {
  background: "var(--surface-2)",
  color: "var(--violet)",
  border: "1px solid var(--border-soft)",
  borderRadius: 10,
  fontSize: 11.5,
  fontFamily: "var(--mono, monospace)",
  padding: "6px 10px",
  width: 260,
};

/**
 * Interactive dependency graph (React Flow): consumer repos (left) → produced surfaces (right), with
 * pan / zoom / fit-to-view / minimap and a text filter. Scales to many nodes where the old fixed SVG
 * clipped. Client component (the app's graph island).
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
      style: { stroke: "var(--border)" },
    }));
    return { nodes: ns, edges: es };
  }, [dependencies, q, repoName]);

  return (
    <div className="card" style={{ height: 480, marginBottom: 16, position: "relative", overflow: "hidden" }}>
      <input
        className="input"
        placeholder="filter by repo or surface…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ position: "absolute", top: 10, left: 10, zIndex: 5, maxWidth: 260 }}
      />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.05}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--border-soft)" gap={20} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ background: "var(--surface-2)" }} />
      </ReactFlow>
    </div>
  );
}
