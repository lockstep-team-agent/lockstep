ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "decision_type" text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN IF NOT EXISTS "impact" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "change_feed_entries" ADD COLUMN IF NOT EXISTS "impact" integer DEFAULT 0 NOT NULL;
