-- Append-only enforcement at the DB level (the audit/non-repudiation guarantee
-- can't be just an app convention). Blocks UPDATE/DELETE on strictly append-only
-- tables. Tables with narrow mutable columns (decisions.status, dependency_edges.active,
-- inboxes.replay_cursor, sessions.state, change_feed_entries.publish_state, …) are NOT
-- frozen here — those updates are allowed; column-level grants tighten them later.

CREATE OR REPLACE FUNCTION lockstep_block_mutations() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
DECLARE frozen text[] := ARRAY[
  'audit_events','decision_versions','answers',
  'ownership_rules','ownership_rule_owners'
];
BEGIN
  FOREACH t IN ARRAY frozen LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lockstep_append_only ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER lockstep_append_only BEFORE UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION lockstep_block_mutations()', t);
  END LOOP;
END $$;
