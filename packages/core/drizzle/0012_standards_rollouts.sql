-- Standards & Skills + Rollouts & Adoption — milestone 1 (authority, catalog, applicability).
-- Org roles are explicit authority, distinct from project ownership.

CREATE TABLE org_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, member_id uuid NOT NULL,
  role text NOT NULL, granted_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_org_role_member UNIQUE(org_id, member_id),
  CONSTRAINT ck_org_role CHECK (role IN ('owner', 'admin'))
);
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, slug text NOT NULL,
  name text NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_slug UNIQUE(org_id, slug)
);
CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, team_id uuid NOT NULL,
  member_id uuid NOT NULL, added_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_member UNIQUE(team_id, member_id)
);
CREATE INDEX ix_team_members_member ON team_members(member_id);

-- Catalog: a stable identity per standard / skill / check; content lives in versions.
CREATE TABLE catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, kind text NOT NULL,
  slug text NOT NULL, name text NOT NULL, owner_member_id uuid,
  archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_catalog_slug UNIQUE(org_id, kind, slug),
  CONSTRAINT ck_catalog_kind CHECK (kind IN ('standard', 'skill', 'check'))
);
CREATE TABLE skill_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
  manifest jsonb NOT NULL, total_bytes integer NOT NULL, package_hash text NOT NULL,
  declared jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_package_hash UNIQUE(org_id, package_hash)
);
CREATE TABLE item_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, item_id uuid NOT NULL,
  version integer NOT NULL, state text NOT NULL DEFAULT 'draft', content jsonb NOT NULL,
  content_hash text NOT NULL, package_id uuid, provenance jsonb, parent_version_id uuid,
  authored_by uuid, proposed_by uuid, approved_by uuid, published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_item_version UNIQUE(item_id, version),
  CONSTRAINT ck_item_version_state CHECK (state IN ('draft', 'proposed', 'published'))
);
CREATE INDEX ix_item_versions_item ON item_versions(item_id, state);

-- A published version is immutable (history + rollback depend on it). Drafts stay editable.
CREATE OR REPLACE FUNCTION lockstep_freeze_published_version() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'item_versions: published version % is immutable', OLD.id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lockstep_freeze_published BEFORE UPDATE OR DELETE ON item_versions
  FOR EACH ROW EXECUTE FUNCTION lockstep_freeze_published_version();

-- Distribution (data only in milestone 1; rollout mechanics arrive in milestone 2).
CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name text NOT NULL,
  items jsonb NOT NULL, release_hash text NOT NULL, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, name text NOT NULL,
  owner_member_id uuid, state text NOT NULL DEFAULT 'active', current_revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assignment_state CHECK (state IN ('active', 'paused', 'retired'))
);
CREATE TABLE assignment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, assignment_id uuid NOT NULL,
  revision integer NOT NULL, release_id uuid NOT NULL, selectors jsonb NOT NULL,
  level text NOT NULL DEFAULT 'required', pilot jsonb, reason text NOT NULL,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assignment_revision UNIQUE(assignment_id, revision),
  CONSTRAINT ck_assignment_level CHECK (level IN ('required', 'recommended'))
);
CREATE TABLE exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, target text NOT NULL,
  item_id uuid NOT NULL, version_id uuid NOT NULL, requirement_key text, scope jsonb NOT NULL,
  reason text NOT NULL, expires_at timestamptz, state text NOT NULL DEFAULT 'requested',
  requested_by uuid, decided_by uuid, decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_exception_target CHECK (target IN ('requirement', 'skill_assignment')),
  CONSTRAINT ck_exception_state CHECK (state IN ('requested', 'approved', 'rejected', 'expired', 'needs_review'))
);
CREATE INDEX ix_exceptions_item ON exceptions(org_id, item_id, state);
--> statement-breakpoint

-- Bootstrap: each existing org's earliest member becomes its owner (never every project owner).
INSERT INTO org_roles (org_id, member_id, role)
SELECT DISTINCT ON (m.org_id) m.org_id, m.id, 'owner' FROM members m
ORDER BY m.org_id, m.created_at, m.id
ON CONFLICT (org_id, member_id) DO NOTHING;
INSERT INTO audit_events (org_id, actor_member_id, action, entity_kind, entity_id, payload)
SELECT r.org_id, NULL, 'org.role_bootstrapped', 'member', r.member_id,
  jsonb_build_object('role', 'owner', 'rule', 'earliest_member')
FROM org_roles r;
