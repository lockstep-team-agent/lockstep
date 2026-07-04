-- v2 human-decision ingestion: proposed/rejected decision lifecycle, origin, and the ingest tables.
-- Hand-authored (db:generate is broken in this repo; see memory/lockstep-mvp-defects). Idempotent.

ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "source_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "tool" text NOT NULL,
  "entity" text NOT NULL,
  "connected_account_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_source_conn_project" ON "source_connections" ("project_id","tool");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ingest_allowlist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "source_ref" text NOT NULL,
  "source_name" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_allowlist_conn_source" ON "ingest_allowlist" ("connection_id","source_ref");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ingest_watermarks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "source_ref" text NOT NULL,
  "cursor" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_watermark_conn_source" ON "ingest_watermarks" ("connection_id","source_ref");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ingest_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "content_hash" text NOT NULL,
  "status" text NOT NULL,
  "confidence" integer,
  "decision_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_artifact_conn_ext_hash" ON "ingest_artifacts" ("connection_id","external_id","content_hash");
