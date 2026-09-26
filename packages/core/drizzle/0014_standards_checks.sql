-- Standards & Skills milestone 3: artifact checks (PRD + code diff), finding actions, and
-- exceptions that bind to CONTENT (so an unchanged requirement carries forward across versions,
-- and a changed one needs review instead of silently keeping or dropping its exception).

ALTER TABLE exceptions ADD COLUMN content_hash text;
ALTER TABLE exceptions ADD COLUMN decision_note text;
ALTER TABLE exceptions ADD COLUMN source_check_id uuid;
CREATE INDEX ix_exceptions_state ON exceptions(org_id, state, expires_at);

-- One evaluation of one artifact revision. Execution is recorded separately from findings.
CREATE TABLE artifact_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  member_id uuid, artifact_kind text NOT NULL, artifact_ref jsonb NOT NULL, artifact_hash text NOT NULL,
  -- what it was checked against: exact standard / check versions and the releases that applied them
  standard_version_id uuid, check_version_id uuid, release_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluator text NOT NULL, execution text NOT NULL, execution_detail text,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb, dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_artifact_kind CHECK (artifact_kind IN ('prd', 'code_diff')),
  CONSTRAINT ck_artifact_execution CHECK (execution IN ('completed', 'partial', 'skipped', 'unavailable', 'error')),
  CONSTRAINT uq_artifact_check UNIQUE(org_id, dedupe_key)
);
CREATE INDEX ix_artifact_checks_project ON artifact_checks(project_id, created_at DESC);

CREATE TABLE finding_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, check_id uuid NOT NULL,
  finding_key text NOT NULL, action text NOT NULL, rationale text NOT NULL, exception_id uuid,
  member_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_finding_action CHECK (action IN ('dismiss', 'exception_requested')),
  CONSTRAINT uq_finding_action UNIQUE(check_id, finding_key, member_id)
);

-- Hourly: expire exceptions past their date (restores applicability; reminds the requester).
INSERT INTO scheduled_jobs (kind, singleton_key, run_at, interval_seconds)
VALUES ('standards_exceptions', 'standards_exceptions', now(), 3600)
ON CONFLICT DO NOTHING;
