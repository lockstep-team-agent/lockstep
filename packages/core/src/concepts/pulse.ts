import { sql, type SQL } from "drizzle-orm";
import { withOrg } from "../db/rls.js";

/**
 * "What did Lockstep do for us this week" — the proof strip on Home. Counts only, last N days,
 * straight from the tables that already record each outcome (no new instrumentation).
 */
export interface Pulse {
  days: number;
  briefed: number; // agent sessions that received a briefing
  routed: number; // changes delivered to the people/services that depend on them
  caught: number; // local checks that flagged code against a rule
  conflicts: number; // rule clashes caught before they shipped
  rulesInForce: number; // binding rules agents follow right now
  newRules: number; // rules that became binding in the window
}

export async function getPulse(orgId: string, projectId: string, days = 7): Promise<Pulse> {
  const since = new Date(Date.now() - days * 86_400_000);
  const queries: Record<Exclude<keyof Pulse, "days">, SQL> = {
    briefed: sql`select count(*) as n from usage_events
      where project_id = ${projectId} and event = 'agent_briefing_delivered' and created_at >= ${since}`,
    routed: sql`select count(distinct i.ref_id) as n from inbox_items i join inboxes b on b.id = i.inbox_id
      where b.project_id = ${projectId} and i.kind = 'change' and i.created_at >= ${since}`,
    caught: sql`select count(*) as n from decision_checks
      where project_id = ${projectId} and created_at >= ${since} and jsonb_array_length(findings) > 0`,
    conflicts: sql`select count(*) as n from conflicts where project_id = ${projectId} and opened_at >= ${since}`,
    rulesInForce: sql`select count(*) as n from decisions where project_id = ${projectId} and status = 'binding'`,
    newRules: sql`select count(*) as n from decisions
      where project_id = ${projectId} and status = 'binding' and created_at >= ${since}`,
  };
  return withOrg(orgId, async (tx) => {
    const out = { days } as Pulse;
    // sequential: one transaction = one connection
    for (const [k, q] of Object.entries(queries)) {
      const rows = (await tx.execute(q)) as unknown as Array<{ n: string | number }>;
      out[k as keyof typeof queries] = Number(rows[0]?.n ?? 0);
    }
    return out;
  });
}
