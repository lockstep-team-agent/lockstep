import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerSession, type Session } from "./mcp/session.js";
import { call } from "./mcp/api.js";
import { trackedFiles } from "./capture/diff.js";
import { extractSurfaces } from "./capture/surface.js";
import { extractOutbound } from "./capture/outbound.js";
import { readManifest, writeManifest } from "./capture/manifest.js";

export interface CatalogEntry {
  surface: string;
  repoId: string;
  gitRemote: string;
}
interface MatchedConsume {
  surface: string;
  producer: string;
}
interface ReviewItem {
  ref: string;
  via: string;
  hint: string;
  candidates: MatchedConsume[];
}
interface UnmatchedItem {
  ref: string;
  via: string;
}

/**
 * The full onboarding/maintenance proposal `/lockstep-setup` renders. `produces` is deterministic
 * (extracted from served routes); `consumes` is graph-resolved (outbound calls matched against the
 * project's produced-surface catalog); `unmatched`/`review` are the fuzzy leftovers the human decides.
 */
export interface ScanProposal {
  connected: boolean;
  produces: string[];
  consumes: MatchedConsume[];
  unmatched: UnmatchedItem[];
  review: ReviewItem[];
  newProduces: string[];
  newConsumes: string[];
}

/** Walk the whole repo → produced surfaces + outbound-call candidates. */
export function scanCode(cwd: string): { produces: string[]; outbound: ReturnType<typeof extractOutbound> } {
  const produces = new Set<string>();
  const outbound = new Map<string, ReturnType<typeof extractOutbound>[number]>();
  for (const f of trackedFiles(cwd)) {
    let content: string;
    try {
      content = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue; // deleted/binary/unreadable — skip
    }
    for (const s of extractSurfaces(f, content)) produces.add(s);
    for (const o of extractOutbound(f, content)) outbound.set(`${o.via} ${o.surface ?? o.hint ?? o.ref}`, o);
  }
  return { produces: [...produces].sort(), outbound: [...outbound.values()] };
}

/**
 * Match key that ignores path-param *names* — a consumer calling `/inventory/${sku}` emits
 * `:param` while the producer serves `:sku`; structurally they're the same endpoint. Only path
 * params (`/:x`) are normalized; the kind prefix (`http:`) and method are left intact.
 */
const matchKey = (surface: string): string => surface.replace(/\/:[^/\s]+/g, "/:");

export function classify(
  outbound: ReturnType<typeof extractOutbound>,
  catalog: CatalogEntry[],
  ownRepoId: string | undefined,
): { consumes: MatchedConsume[]; unmatched: UnmatchedItem[]; review: ReviewItem[] } {
  const producers = catalog.filter((e) => e.repoId !== ownRepoId);
  const byKey = new Map<string, CatalogEntry>();
  for (const e of producers) if (!byKey.has(matchKey(e.surface))) byKey.set(matchKey(e.surface), e);

  const consumes: MatchedConsume[] = [];
  const consumeSet = new Set<string>();
  const unmatched: UnmatchedItem[] = [];
  const review: ReviewItem[] = [];
  for (const ref of outbound) {
    const hit = ref.surface ? byKey.get(matchKey(ref.surface)) : undefined;
    if (hit) {
      // Record the PRODUCER's canonical surface (not the consumer's guessed param name) so the
      // dependency edge matches the producer's future change events exactly.
      if (!consumeSet.has(hit.surface)) {
        consumeSet.add(hit.surface);
        consumes.push({ surface: hit.surface, producer: hit.gitRemote });
      }
    } else if (ref.hint) {
      // service/package hint (gRPC client, generated import) — resolve to the sibling's surfaces it could mean.
      const candidates = producers
        .filter((e) => e.surface.toLowerCase().includes(ref.hint!))
        .map((e) => ({ surface: e.surface, producer: e.gitRemote }));
      if (candidates.length > 0) review.push({ ref: ref.ref, via: ref.via, hint: ref.hint, candidates });
    } else if (ref.surface) {
      unmatched.push({ ref: ref.ref, via: ref.via }); // a real outbound call with no producer in the graph
    }
  }
  return { consumes, unmatched, review };
}

async function buildProposal(cwd: string): Promise<{ proposal: ScanProposal; session?: Session }> {
  const { produces, outbound } = scanCode(cwd);
  let session: Session | undefined;
  let catalog: CatalogEntry[] = [];
  try {
    session = await registerSession(process.env.LOCKSTEP_VENDOR ?? "claude");
    const res = await call<{ surfaces: CatalogEntry[] }>("GET", "/surfaces", session.sessionId);
    catalog = res.surfaces ?? [];
  } catch {
    session = undefined; // not connected / not logged in — produces still work, consumes can't be resolved
  }
  const { consumes, unmatched, review } = classify(outbound, catalog, session?.repoId);
  const manifest = readManifest(cwd);
  const proposal: ScanProposal = {
    connected: Boolean(session),
    produces,
    consumes,
    unmatched,
    review,
    newProduces: produces.filter((s) => !manifest.produces.includes(s)),
    newConsumes: consumes.map((c) => c.surface).filter((s) => !manifest.consumes.includes(s)),
  };
  return { proposal, session };
}

export function report(p: ScanProposal): string {
  const L: string[] = [];
  L.push(`produces (${p.produces.length}, ${p.newProduces.length} new):`);
  for (const s of p.produces) L.push(`  ${p.newProduces.includes(s) ? "+" : " "} ${s}`);
  if (!p.connected) {
    L.push(``, `consumes: not resolved — run \`lockstep connect\` so calls can be matched against the graph.`);
    return L.join("\n");
  }
  L.push(``, `consumes — matched to the graph (${p.consumes.length}, ${p.newConsumes.length} new):`);
  for (const c of p.consumes)
    L.push(`  ${p.newConsumes.includes(c.surface) ? "+" : " "} ${c.surface}  → ${c.producer}`);
  if (p.review.length) {
    L.push(``, `needs review — client/import hints that could map to a sibling (${p.review.length}):`);
    for (const r of p.review) L.push(`  ? ${r.ref} (${r.via}) → ${r.candidates.map((c) => c.surface).join(", ")}`);
  }
  if (p.unmatched.length) {
    L.push(
      ``,
      `unmatched — outbound calls with no producer in the graph (external, or not yet onboarded) (${p.unmatched.length}):`,
    );
    for (const u of p.unmatched) L.push(`    ${u.ref} (${u.via})`);
  }
  return L.join("\n");
}

/**
 * `lockstep scan` — bootstrap/maintenance for `lockstep.yaml`. Default prints a proposal; `--json` emits
 * it for the skill; `--apply` writes the manifest (merge-preserving) and syncs it to the graph.
 */
export async function runScan(opts: { json?: boolean; apply?: boolean; dryRun?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const { proposal, session } = await buildProposal(cwd);

  if (opts.json) {
    process.stdout.write(JSON.stringify(proposal, null, 2) + "\n");
  } else {
    process.stdout.write(report(proposal) + "\n");
  }

  if (!opts.apply) return;

  const status = await writeManifest(
    cwd,
    { produces: proposal.produces, consumes: proposal.consumes.map((c) => c.surface) },
    { dryRun: opts.dryRun },
  );
  process.stderr.write(`[lockstep] ${status}\n`);

  // Sync to the graph so the catalog stays complete and the dependency edges are recorded.
  if (session && !opts.dryRun) {
    await call("POST", "/surfaces", session.sessionId, { surfaces: proposal.produces }).catch(() => {});
    for (const c of proposal.consumes) {
      await call("POST", "/dependencies", session.sessionId, { producedSurface: c.surface, source: "manifest" }).catch(
        () => {},
      );
    }
    process.stderr.write(
      `[lockstep] synced ${proposal.produces.length} produce(s) + ${proposal.consumes.length} consume(s) to the graph\n`,
    );
  }
}
