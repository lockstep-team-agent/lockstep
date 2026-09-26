-- Verification fix: contact time (any request) is not verification. verified_at advances only when
-- the server accepts a completed reconciliation from the environment; freshness is judged by it.
ALTER TABLE environments ADD COLUMN verified_at timestamptz;
