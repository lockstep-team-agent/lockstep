-- Standards & Skills milestone 2: enrolled environments, receipts, withdrawn releases.
-- Desired state is resolved on request from current assignments (no materialized table); a
-- receipt's `generation` is the hash of the desired set it synced, so a stale ack can't pass as current.

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, member_id uuid NOT NULL,
  adapter text NOT NULL, adapter_version text, host_key text NOT NULL,
  context_kind text NOT NULL DEFAULT 'repo', project_id uuid, repo_id uuid,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- recommended skills this environment opted into / declined, by catalog item id
  accepted jsonb NOT NULL DEFAULT '[]'::jsonb, declined jsonb NOT NULL DEFAULT '[]'::jsonb,
  enrolled_at timestamptz NOT NULL DEFAULT now(), last_contact_at timestamptz NOT NULL DEFAULT now(),
  unenrolled_at timestamptz,
  CONSTRAINT uq_environment UNIQUE(org_id, member_id, adapter, host_key),
  CONSTRAINT ck_environment_adapter CHECK (adapter IN ('claude', 'codex')),
  CONSTRAINT ck_environment_context CHECK (context_kind IN ('repo', 'workspace'))
);
CREATE INDEX ix_environments_org ON environments(org_id, project_id, repo_id);

-- Append-only evidence from environments. Operational metadata only: no prompts, code or paths.
CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, env_id uuid NOT NULL,
  kind text NOT NULL, item_id uuid, version_id uuid, package_hash text, session_id uuid,
  generation text NOT NULL, detail jsonb, observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_receipt_kind CHECK (kind IN ('synced', 'installed', 'removed', 'failed', 'conflict',
    'declined', 'readiness_gap', 'session_available', 'invoked'))
);
CREATE INDEX ix_receipts_env_item ON receipts(env_id, item_id, received_at DESC);

CREATE TABLE release_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, release_id uuid NOT NULL,
  reason text NOT NULL, replacement_release_id uuid, withdrawn_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_release_withdrawal UNIQUE(release_id)
);
