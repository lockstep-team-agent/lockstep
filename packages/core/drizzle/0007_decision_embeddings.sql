-- #6 embedding-based fusion/supersession: a MUTABLE, lazily-populated cache of the current
-- version's ruleText embedding per decision. jsonb float array + TS cosine, deliberately NOT
-- pgvector (user-confirmed deviation): the only comparison is among <10 scope-mates per
-- (project, scopeRef), where an ANN index buys nothing and the extension costs a Postgres image
-- swap + Railway availability risk. NOT append-only — staleness (version < decisions.current_version)
-- heals on next read.
-- Hand-authored, idempotent (db:generate is broken in this repo).

CREATE TABLE IF NOT EXISTS "decision_embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "decision_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "model" text NOT NULL,
  "embedding" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_decision_embedding" ON "decision_embeddings" ("decision_id");
