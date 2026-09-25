-- Cached "why was this raised" summaries for approvers: one per decision version, generated once.
CREATE TABLE decision_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  decision_id uuid NOT NULL, version integer NOT NULL, summary text NOT NULL, model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_decision_summary UNIQUE(decision_id, version)
);
