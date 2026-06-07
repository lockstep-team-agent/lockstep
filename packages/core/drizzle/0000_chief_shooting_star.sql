CREATE TABLE IF NOT EXISTS "access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[],
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"body" text NOT NULL,
	"answered_by" uuid,
	"written_back_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_member_id" uuid,
	"action" text NOT NULL,
	"entity_kind" text,
	"entity_id" uuid,
	"entity_version" integer,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "change_feed_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"contract_id" uuid,
	"surface" text,
	"risk_tier" text DEFAULT 'owned' NOT NULL,
	"publish_state" text DEFAULT 'drafted' NOT NULL,
	"provenance" jsonb,
	"diff_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"delta" jsonb,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_against" text,
	"verification_status" text DEFAULT 'asserted_unverified' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_required_reviewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"reviewer_member_id" uuid NOT NULL,
	"required" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decision_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"base_version" integer NOT NULL,
	"rule_text" text NOT NULL,
	"provenance" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"proposed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ref" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dependency_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"consumer_repo_id" uuid NOT NULL,
	"produced_repo_id" uuid,
	"produced_surface" text NOT NULL,
	"source" text DEFAULT 'register_dependency' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_id" uuid NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"scopes" text[],
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"reason" jsonb,
	"state" text DEFAULT 'unread' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"replay_cursor" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"display_name" text,
	"email" text,
	"vendors_in_use" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"identity_provider" text DEFAULT 'github' NOT NULL,
	"retention_policy" jsonb,
	"deployment" text DEFAULT 'self-host' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ownership_rule_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"owner_login" text NOT NULL,
	"member_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ownership_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"pattern_regex" text NOT NULL,
	"precedence" integer NOT NULL,
	"source" text DEFAULT 'codeowners' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ownership_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"codeowners_sha" text,
	"built_from" text DEFAULT 'codeowners' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"display_name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"member_id" uuid,
	"invited_github_login" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ref" text,
	"body" text NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"route_trace" jsonb,
	"asked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"git_remote" text NOT NULL,
	"default_branch" text DEFAULT 'main',
	"codeowners_sha" text,
	"is_monorepo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"git_remote" text NOT NULL,
	"cwd" text,
	"vendor" text,
	"token_id" uuid,
	"last_heartbeat" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'live' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"refs" jsonb,
	"delegated_to" uuid,
	"delegated_by" uuid,
	"approver" uuid,
	"run_state" text DEFAULT 'queued' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_token_hash" ON "access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_entity" ON "audit_events" USING btree ("entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_contract_repo_surface" ON "contracts" USING btree ("repo_id","surface");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_decision_version" ON "decision_versions" USING btree ("decision_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_dep_surface_active" ON "dependency_edges" USING btree ("produced_surface","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_dep_producer_surface" ON "dependency_edges" USING btree ("produced_repo_id","produced_surface");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_install_org" ON "github_installations" USING btree ("org_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_item" ON "inbox_items" USING btree ("inbox_id","kind","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbox_member_repo_project" ON "inboxes" USING btree ("member_id","repo_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_members_org_principal" ON "members" USING btree ("org_id","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_members_org_login" ON "members" USING btree ("org_id","github_login");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ownership_rule_snapshot" ON "ownership_rules" USING btree ("snapshot_id","precedence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ownership_snapshot_current" ON "ownership_snapshots" USING btree ("repo_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_member_login" ON "project_members" USING btree ("project_id","invited_github_login");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_repo_project_remote" ON "repos" USING btree ("project_id","git_remote");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_repo_remote" ON "repos" USING btree ("git_remote");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_session_repo_state" ON "sessions" USING btree ("project_id","repo_id","state");