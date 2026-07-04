/**
 * Expiry-hint parsing (v3, pure). Launch gates carry hints like "2026-08-01", "in 30 days", or
 * "30 days post-launch". Calendar-anchored forms resolve to a Date the expiry job can act on;
 * event-relative forms ("post-launch", "after GA") have no calendar anchor yet — the hint is stored
 * verbatim and expiresAt stays null (plan D13).
 */

const EVENT_RELATIVE = /\b(post|after|once|upon|when|launch|ga|beta|release)\b/i;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const NOW_RELATIVE = /(\d+)\s*(day|week|month|year)s?\b/i;

export function parseExpiresHint(hint: string, now: Date): Date | null {
  const h = hint.trim();
  if (!h) return null;
  if (EVENT_RELATIVE.test(h)) return null; // event-anchored — nothing on the calendar to point at
  const iso = h.match(ISO_DATE);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const rel = h.match(NOW_RELATIVE);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(now.getTime());
    switch (rel[2]!.toLowerCase()) {
      case "day":
        d.setUTCDate(d.getUTCDate() + n);
        break;
      case "week":
        d.setUTCDate(d.getUTCDate() + n * 7);
        break;
      case "month":
        d.setUTCMonth(d.getUTCMonth() + n);
        break;
      default:
        d.setUTCFullYear(d.getUTCFullYear() + n);
    }
    return d;
  }
  // "August 1, 2026" and friends — trust Date.parse only when a 4-digit year is present.
  if (/\d{4}/.test(h)) {
    const t = Date.parse(h);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}
