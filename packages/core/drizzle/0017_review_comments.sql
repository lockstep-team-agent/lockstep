-- PR review comments (GitHub webhook). Recurring similar comments become one proposed standard;
-- decision_id marks the comments already folded into it. Unique per project: one remote can be
-- connected to several projects.
CREATE TABLE review_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL,
  repo_id uuid NOT NULL, pr_number integer NOT NULL, author_member_id uuid, body text NOT NULL,
  url text NOT NULL, github_comment_id text NOT NULL, decision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_review_comment_project_gh ON review_comments(project_id, github_comment_id);
CREATE INDEX ix_review_comments_project ON review_comments(project_id, created_at);
