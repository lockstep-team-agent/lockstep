/**
 * Confidence crosses the API on exactly ONE scale: a 0..1 fraction, which the dashboard renders as a
 * percentage by multiplying by 100.
 *
 * Storage does NOT use that scale. The `confidence` COLUMNS (`ingest_artifacts.confidence`,
 * `decision_provenances.confidence`) are 0..100 integers, while the provenance JSON blob already
 * holds the fraction. Serving a column value straight out of a read endpoint is therefore 100x too
 * large and renders as "10000%". Every read of one of those columns goes through here.
 */
export function confidenceFraction(stored: number | null | undefined): number | null {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return null;
  return stored / 100;
}
