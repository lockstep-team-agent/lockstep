import type { ProvenanceRow } from "@/lib/data";

/** Provenance rows with their quoted evidence — the violet blockquotes shared by Proposed + Ratifications. */
export function EvidenceBlock({ rows }: { rows: ProvenanceRow[] }) {
  return (
    <>
      {rows.map((row, ri) => (
        <div key={ri} style={{ marginTop: 10 }}>
          <div className="meta" style={{ marginBottom: 4 }}>
            <span>via {row.source}</span>
            {row.url && (
              <a href={row.url} target="_blank" rel="noreferrer" className="code-ref">
                open ↗
              </a>
            )}
          </div>
          {(row.evidence ?? []).map((e, i) => (
            <blockquote key={i} className="evidence">
              “{e.quote}”
            </blockquote>
          ))}
        </div>
      ))}
    </>
  );
}
