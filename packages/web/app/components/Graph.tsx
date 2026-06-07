import type { ProjectOverview } from "../lib/types";

const short = (remote: string) => remote.split("/").pop() ?? remote;

/**
 * Layered dependency graph: consumer repos (left) → produced surfaces (right).
 * Pure SVG, animated edge draw-in. Server component.
 */
export function DependencyGraph({
  repos,
  dependencies,
}: {
  repos: ProjectOverview["repos"];
  dependencies: ProjectOverview["dependencies"];
}) {
  const repoName = new Map(repos.map((r) => [r.id, short(r.gitRemote)]));

  const consumers = [...new Set(dependencies.map((d) => d.consumerRepoId))];
  const surfaces = [...new Set(dependencies.map((d) => d.producedSurface))];

  const NODE_H = 46;
  const GAP = 22;
  const COL_W = 210;
  const COL_GAP = 170;
  const PAD = 24;
  const leftX = PAD;
  const rightX = PAD + COL_W + COL_GAP;
  const rows = Math.max(consumers.length, surfaces.length, 1);
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * GAP + 24;
  const width = rightX + COL_W + PAD;

  const yOf = (i: number, count: number) => {
    const block = count * NODE_H + (count - 1) * GAP;
    const start = (height - block) / 2;
    return start + i * (NODE_H + GAP);
  };
  const consumerY = (id: string) => yOf(consumers.indexOf(id), consumers.length);
  const surfaceY = (s: string) => yOf(surfaces.indexOf(s), surfaces.length);

  return (
    <div className="graph animate-in">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Dependency graph">
        <text className="glabel" x={leftX} y={20}>CONSUMERS</text>
        <text className="glabel" x={rightX} y={20}>PRODUCED SURFACES</text>

        {dependencies.map((d) => {
          const y1 = consumerY(d.consumerRepoId) + NODE_H / 2;
          const y2 = surfaceY(d.producedSurface) + NODE_H / 2;
          const x1 = leftX + COL_W;
          const x2 = rightX;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={d.id}
              className="gedge"
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
            />
          );
        })}

        {consumers.map((id, i) => {
          const y = yOf(i, consumers.length);
          return (
            <g className="gnode" key={id} transform={`translate(${leftX},${y})`}>
              <rect width={COL_W} height={NODE_H} />
              <text x={14} y={20}>{repoName.get(id) ?? "repo"}</text>
              <text className="sub" x={14} y={36}>consumer</text>
            </g>
          );
        })}

        {surfaces.map((s, i) => {
          const y = yOf(i, surfaces.length);
          const producer = dependencies.find((d) => d.producedSurface === s)?.producedRepoId;
          return (
            <g className="gnode gsurface" key={s} transform={`translate(${rightX},${y})`}>
              <rect width={COL_W} height={NODE_H} />
              <text x={14} y={20}>{s}</text>
              <text className="sub" x={14} y={36}>{producer ? repoName.get(producer) ?? "service" : "external"}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
