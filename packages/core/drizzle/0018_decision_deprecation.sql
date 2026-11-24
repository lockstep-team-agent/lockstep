-- Deprecations as first-class decisions: decisionType "deprecation" carries a structured
-- {retired, replacement} pair on the version, so briefings render it and the PR gate can match it.
ALTER TABLE decision_versions ADD COLUMN deprecation jsonb;
