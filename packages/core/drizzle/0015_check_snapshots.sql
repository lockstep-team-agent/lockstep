-- Review fix: every check result stores exactly what it evaluated (check version, requirement
-- versions with their exemptions, releases). Its hash is the cache key and the staleness basis.
ALTER TABLE artifact_checks ADD COLUMN evaluated jsonb NOT NULL DEFAULT '{}'::jsonb;
