import { fail } from "./service.js";

/** Bounded per-process pilot guard. Shared edge limits are also required when deploying replicas. */
export function modelBudget(limit = 30, concurrent = 3) {
  const members = new Map<string, { until: number; count: number; active: number }>();
  return async <T>(memberId: string, work: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    for (const [key, entry] of members) if (entry.until <= now && entry.active === 0) members.delete(key);
    let entry = members.get(memberId);
    if (!entry) {
      if (members.size >= 10000) throw fail("provider capacity unavailable; retry shortly", 503);
      entry = { until: now + 60000, count: 0, active: 0 }; members.set(memberId, entry);
    }
    if (entry.count >= limit || entry.active >= concurrent) throw fail("provider request limit reached; retry after one minute", 429);
    entry.count++; entry.active++;
    try { return await work(); } finally { entry.active--; }
  };
}
