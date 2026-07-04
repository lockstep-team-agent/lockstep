/**
 * The seam between Lockstep and a human-coordination tool. Composio backs it today (ComposioConnector);
 * a self-hosted Nango backend can implement the same interface later (Phase 4) without touching the
 * distillation funnel. StubConnector implements it for deterministic tests.
 */

/** A conversation unit — the atom the funnel distills. A Slack thread (root + replies) is one unit. */
export interface Unit {
  /** Stable id within a source, e.g. `${channelId}/${threadTs}`. Idempotency key with contentHash. */
  externalId: string;
  sourceRef: string; // the allowlisted source this came from (channel id)
  sourceName?: string; // #channel label
  /** Full concatenated text of the unit (root message + replies), author-attributed. */
  text: string;
  authors: string[]; // display handles/ids that participated
  ts: string; // root timestamp — the watermark cursor advances past the max ts seen
  permalink?: string; // deep link back to the source, for provenance
}

export interface Channel {
  id: string;
  name: string;
}

export interface SourceConnector {
  /** List channels/projects/spaces available to this connection (helps the admin pick allowlist entries). */
  listChannels(): Promise<Channel[]>;
  /**
   * Return conversation units in one allowlisted source that are newer than `sinceCursor`
   * (null = the connector's default window, e.g. last 7 days). Newest-inclusive.
   */
  listUnitsSince(sourceRef: string, sinceCursor: string | null): Promise<Unit[]>;
}
