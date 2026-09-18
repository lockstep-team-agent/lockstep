import { RefChip } from "@/components/RefChip";

/** A verbatim quote with where it came from — shared by the Review queue and Decision detail. */
export function EvidenceQuote({
  quote,
  source,
  url,
  confidence,
}: {
  quote: string;
  source?: string | null;
  url?: string | null;
  confidence?: number | null;
}) {
  return (
    <figure className="my-2 border-l-2 border-primary-edge pl-3">
      <blockquote className="text-sm text-foreground/90">“{quote}”</blockquote>
      {(source || url || typeof confidence === "number") && (
        <figcaption className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {source && <span>via {source}</span>}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="hover:text-foreground">
              open ↗
            </a>
          )}
          {typeof confidence === "number" && (
            <RefChip copy={false}>{`confidence ${Math.round(confidence * 100)}%`}</RefChip>
          )}
        </figcaption>
      )}
    </figure>
  );
}
