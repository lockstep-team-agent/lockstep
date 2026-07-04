-- v2 Phase 2/3: cross-tool provenance fusion + org graph. Hand-authored, idempotent.

CREATE TABLE IF NOT EXISTS "decision_provenances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "decision_id" uuid NOT NULL,
  "source" text NOT NULL,
  "external_id" text,
  "url" text,
  "evidence" jsonb,
  "confidence" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_provenance_decision" ON "decision_provenances" ("decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_provenance_decision_source" ON "decision_provenances" ("decision_id","source","external_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "graph_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "label" text,
  "source" text DEFAULT 'derived' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_graph_node" ON "graph_nodes" ("project_id","kind","ref");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "graph_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "from_id" uuid NOT NULL,
  "to_id" uuid NOT NULL,
  "kind" text DEFAULT 'relates' NOT NULL,
  "weight" integer DEFAULT 1 NOT NULL,
  "source" text DEFAULT 'derived' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_graph_edge" ON "graph_edges" ("project_id","from_id","to_id","kind");
