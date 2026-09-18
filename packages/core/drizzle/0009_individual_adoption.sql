ALTER TABLE sessions ADD COLUMN native_session_id text;
ALTER TABLE sessions ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN briefing_baseline timestamptz;
CREATE UNIQUE INDEX uq_session_native ON sessions(member_id, repo_id, vendor, native_session_id);
CREATE TABLE briefing_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, member_id uuid NOT NULL,
  repo_id uuid NOT NULL, seen_at timestamptz NOT NULL,
  CONSTRAINT uq_briefing_cursor UNIQUE(member_id, repo_id)
);
CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  member_id uuid NOT NULL, repo_id uuid, session_id uuid, event text NOT NULL, event_key text NOT NULL,
  counts jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_usage_event UNIQUE(org_id, member_id, event, event_key)
);
CREATE TABLE decision_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  repo_id uuid NOT NULL, member_id uuid NOT NULL, session_id uuid NOT NULL, fingerprint text NOT NULL,
  status text NOT NULL, feature_ref text, checked integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0,
  partial boolean NOT NULL DEFAULT false, findings jsonb NOT NULL DEFAULT '[]', rule_versions jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_decision_check UNIQUE(member_id, repo_id, fingerprint)
);
CREATE TABLE check_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  check_id uuid NOT NULL, decision_id uuid NOT NULL, member_id uuid NOT NULL, verdict text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_check_feedback UNIQUE(check_id, decision_id, member_id)
);
CREATE TABLE native_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  document_id uuid NOT NULL, version integer NOT NULL, title text NOT NULL, content text NOT NULL,
  feature_ref text NOT NULL, content_hash text NOT NULL, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT uq_native_doc_version UNIQUE(document_id, version)
);
