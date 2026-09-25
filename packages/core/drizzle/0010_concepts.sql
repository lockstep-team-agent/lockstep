-- Concept ledger: stable surfaces + Domain -> Concept -> Items navigation layer.
-- Concepts are navigation-only: nothing here changes what a decision governs.

-- Stable surface identity. contracts rows become the per-change history under a surface.
CREATE TABLE surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  repo_id uuid NOT NULL, surface text NOT NULL, kind text NOT NULL,
  return_type text, return_type_kind text,
  first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT uq_surface_repo UNIQUE(repo_id, surface)
);
CREATE INDEX ix_surfaces_project ON surfaces(project_id);
ALTER TABLE contracts ADD COLUMN surface_id uuid;
--> statement-breakpoint
INSERT INTO surfaces (org_id, project_id, repo_id, surface, kind, first_seen, last_seen)
SELECT c.org_id, r.project_id, c.repo_id, c.surface,
  CASE
    WHEN c.surface ~ '^(http|gql|proto|event|ws):' THEN split_part(c.surface, ':', 1)
    WHEN c.surface ~ '^[A-Z]+ /' THEN 'http'
    WHEN c.surface ~ '^[a-z][a-z0-9_-]*:' THEN split_part(c.surface, ':', 1)
    ELSE 'unknown'
  END,
  min(c.created_at), max(c.created_at)
FROM contracts c JOIN repos r ON r.id = c.repo_id
GROUP BY c.org_id, r.project_id, c.repo_id, c.surface
ON CONFLICT (repo_id, surface) DO NOTHING;
--> statement-breakpoint
UPDATE contracts c SET surface_id = s.id FROM surfaces s WHERE s.repo_id = c.repo_id AND s.surface = c.surface;
CREATE INDEX ix_contracts_surface_id ON contracts(surface_id);
--> statement-breakpoint

-- One row per project: rebuild generation + normalization rules. Also the sync-vs-rebuild lock row.
CREATE TABLE concept_projects (
  project_id uuid PRIMARY KEY, org_id uuid NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  http_rules jsonb,
  rule_version integer NOT NULL DEFAULT 1
);
CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  key text NOT NULL, label text NOT NULL, position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_domain_key UNIQUE(project_id, key)
);
CREATE TABLE concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  key text NOT NULL, label text NOT NULL, rule_version integer NOT NULL DEFAULT 1,
  domain_id uuid, domain_state text NOT NULL DEFAULT 'pending',
  domain_classifier text, domain_confidence real,
  domain_revision integer NOT NULL DEFAULT 0, input_version integer NOT NULL DEFAULT 1,
  generation integer NOT NULL DEFAULT 0, retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_concept_key UNIQUE(project_id, key)
);
CREATE INDEX ix_concepts_domain ON concepts(project_id, domain_id);
CREATE TABLE concept_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  alias_key text NOT NULL, concept_id uuid NOT NULL,
  CONSTRAINT uq_concept_alias UNIQUE(project_id, alias_key)
);
CREATE TABLE concept_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  item_kind text NOT NULL, item_id uuid NOT NULL,
  location text NOT NULL DEFAULT 'unplaced', concept_id uuid,
  state text NOT NULL DEFAULT 'pending', classifier text, confidence real,
  revision integer NOT NULL DEFAULT 0, input_version integer NOT NULL DEFAULT 1,
  generation integer NOT NULL DEFAULT 0, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_concept_placement UNIQUE(project_id, item_kind, item_id),
  CONSTRAINT ck_placement_location CHECK ((location = 'concept') = (concept_id IS NOT NULL))
);
CREATE INDEX ix_placements_concept ON concept_placements(concept_id, item_kind);
CREATE INDEX ix_placements_location ON concept_placements(project_id, location, state);
CREATE TABLE concept_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  item_kind text NOT NULL, item_id uuid NOT NULL, concept_id uuid NOT NULL,
  source text NOT NULL, generation integer NOT NULL DEFAULT 0,
  CONSTRAINT uq_concept_ref UNIQUE(item_kind, item_id, concept_id)
);
CREATE INDEX ix_refs_concept ON concept_refs(concept_id);
CREATE TABLE concept_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  target_kind text NOT NULL, target_id uuid NOT NULL, field text NOT NULL,
  payload jsonb, by_member_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_concept_override UNIQUE(target_kind, target_id, field)
);
CREATE TABLE concept_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  kind text NOT NULL, dedupe_key text NOT NULL, payload jsonb,
  state text NOT NULL DEFAULT 'queued', dirty boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, locked_until timestamptz, claimed_input_version integer,
  last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_concept_task_live ON concept_tasks(project_id, dedupe_key)
  WHERE state IN ('queued', 'running');
CREATE INDEX ix_concept_tasks_due ON concept_tasks(state, next_attempt_at);
CREATE TABLE concept_rebuilds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  generation integer NOT NULL, phase text NOT NULL DEFAULT 'deriving',
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX ix_concept_rebuilds_project ON concept_rebuilds(project_id, started_at);
CREATE TABLE concept_rebuild_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  rebuild_id uuid NOT NULL, dedupe_key text NOT NULL, required_input_version integer NOT NULL,
  satisfied_at timestamptz,
  CONSTRAINT uq_rebuild_item UNIQUE(rebuild_id, dedupe_key)
);
CREATE INDEX ix_rebuild_items_key ON concept_rebuild_items(dedupe_key) WHERE satisfied_at IS NULL;
--> statement-breakpoint

-- Backfill: every existing project gets its concept row, the default domains, and a rebuild task
-- (the drain derives concepts from its surfaces and decisions).
INSERT INTO concept_projects (project_id, org_id) SELECT id, org_id FROM projects ON CONFLICT DO NOTHING;
INSERT INTO domains (org_id, project_id, key, label, position)
SELECT p.id_org, p.id, d.key, d.label, d.position
FROM (SELECT id, org_id AS id_org FROM projects) p
CROSS JOIN (VALUES
  ('identity', 'Identity & Access', 0), ('users', 'Users & Accounts', 1),
  ('payments', 'Payments & Billing', 2), ('content', 'Content & Catalog', 3),
  ('messaging', 'Messaging & Notifications', 4), ('data', 'Data & Analytics', 5),
  ('integrations', 'Integrations', 6), ('platform', 'Platform & Infra', 7)
) AS d(key, label, position)
ON CONFLICT (project_id, key) DO NOTHING;
INSERT INTO concept_tasks (org_id, project_id, kind, dedupe_key)
SELECT org_id, id, 'rebuild', 'rebuild:' || id FROM projects
ON CONFLICT DO NOTHING;
INSERT INTO scheduled_jobs (kind, singleton_key, run_at, interval_seconds)
VALUES ('concept_drain', 'concept_drain', now(), 60)
ON CONFLICT DO NOTHING;
