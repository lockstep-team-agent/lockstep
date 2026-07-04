-- v3 Phase A: product layer — PRD documents, state mappings, conflicts, write-back queue.
-- Hand-authored, idempotent (db:generate is broken in this repo).

CREATE TABLE IF NOT EXISTS "source_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "connection_id" uuid,
  "tool" text DEFAULT 'notion' NOT NULL,
  "container_ref" text,
  "external_id" text NOT NULL,
  "title" text,
  "url" text,
  "state" text DEFAULT 'draft' NOT NULL,
  "state_authority" text DEFAULT 'mirrored' NOT NULL,
  "source_state_value" text,
  "owner_ref" text,
  "owner_member_id" uuid,
  "registered_by" uuid,
  "content_hash" text,
  "force_resync" boolean DEFAULT false NOT NULL,
  "digest_seq" integer DEFAULT 0 NOT NULL,
  "last_swept_at" timestamp with time zone,
  "last_extracted_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_source_doc_conn_ext" ON "source_documents" ("connection_id","external_id") WHERE "connection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_source_doc_native_ext" ON "source_documents" ("project_id","external_id") WHERE "connection_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_source_doc_project_state" ON "source_documents" ("project_id","state");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "document_state_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "container_ref" text NOT NULL,
  "container_name" text,
  "status_property" text,
  "mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "unmapped_behavior" text DEFAULT 'draft' NOT NULL,
  "pending_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_state_mapping_conn_container" ON "document_state_mappings" ("connection_id","container_ref");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "constraint_decision_id" uuid NOT NULL,
  "eng_decision_id" uuid,
  "candidate_decision_id" uuid,
  "surface" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "dismiss_reason" text,
  "write_back_ref" text,
  "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_conflicts_status_project" ON "conflicts" ("status","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_conflicts_surface_status" ON "conflicts" ("surface","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_conflict_pair" ON "conflicts" ("constraint_decision_id","eng_decision_id","kind");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "writebacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "connection_id" uuid,
  "tool" text NOT NULL,
  "kind" text NOT NULL,
  "target_ref" text NOT NULL,
  "payload" jsonb NOT NULL,
  "dedupe_key" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "result_ref" text,
  "posted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_writeback_dedupe" ON "writebacks" ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_writebacks_status" ON "writebacks" ("status");--> statement-breakpoint

ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "constraint_kind" text;--> statement-breakpoint
ALTER TABLE "decision_provenances" ADD COLUMN IF NOT EXISTS "anchor" jsonb;--> statement-breakpoint
ALTER TABLE "decision_provenances" ADD COLUMN IF NOT EXISTS "anchor_status" text DEFAULT 'valid' NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_edges" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "settings" jsonb;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "slack_user_id" text;
