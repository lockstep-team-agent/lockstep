-- #10 org-level connections: connect each Slack/Notion workspace ONCE per org; routing to projects
-- happens purely via ingest_allowlist rows (which already carry their own project_id).
-- NO row consolidation / repointing: a legacy per-project connection row already IS an org-level
-- connection once routing is per-allowlist-row — it keeps its id (all child tables keep pointing at
-- it), its entity (opaque Composio userId, so the OAuth account keeps resolving — no re-auth), and
-- its connectedAccountId. New connections use entity = orgId.
-- Hand-authored, idempotent (db:generate is broken in this repo).

ALTER TABLE "source_connections" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "source_connections" SET "project_id" = NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "ix_source_conn_project";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_source_conn_org" ON "source_connections" ("org_id","tool");
