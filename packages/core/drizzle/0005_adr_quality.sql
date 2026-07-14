-- Phase J: ADR/decision-quality — deliberation fields (rationale, alternatives), review
-- tripwires (review_at), and first-class supersession (superseded_by_id).
-- Hand-authored, idempotent (db:generate is broken in this repo).

ALTER TABLE "decision_versions" ADD COLUMN IF NOT EXISTS "rationale" text;--> statement-breakpoint
ALTER TABLE "decision_versions" ADD COLUMN IF NOT EXISTS "alternatives" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_decisions_review" ON "decisions" ("project_id","review_at") WHERE "review_at" IS NOT NULL;--> statement-breakpoint

-- Backfill rationale/alternatives out of the version provenance jsonb where the ingest
-- funnel has been stashing them. decision_versions is append-only (sql/0002); drop the
-- trigger for the one-time copy and recreate it inline so this file is self-contained
-- (fresh DBs have neither trigger nor function yet — sql/0002 re-applies after migrations
-- on every boot regardless).
DROP TRIGGER IF EXISTS lockstep_append_only ON "decision_versions";--> statement-breakpoint
UPDATE "decision_versions"
  SET "rationale" = "provenance"->>'rationale'
  WHERE "rationale" IS NULL AND COALESCE("provenance"->>'rationale', '') <> '';--> statement-breakpoint
UPDATE "decision_versions"
  SET "alternatives" = "provenance"->'alternatives'
  WHERE "alternatives" IS NULL AND jsonb_typeof("provenance"->'alternatives') = 'array';--> statement-breakpoint
CREATE OR REPLACE FUNCTION lockstep_block_mutations() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER lockstep_append_only BEFORE UPDATE OR DELETE ON "decision_versions"
  FOR EACH ROW EXECUTE FUNCTION lockstep_block_mutations();
