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

/* ── Documents (v3 product layer) ── */

/** A heading-anchored slice of a PRD — the atom the doc funnel distills. */
export interface DocSection {
  /** Stable anchor within the doc — the heading block id (the page id for the pre-heading preamble). */
  anchorKey: string;
  headingPath: string[]; // stack of heading texts down to this section, [] for the preamble
  text: string; // heading + section body, plain text
  snippet: string; // first ~120 chars of the section body, for anchor re-verification
}

/** Listing-level metadata for one document in an allowlisted container (Notion database). */
export interface DocMeta {
  externalId: string; // page id
  containerRef: string; // the database it was listed from
  title: string;
  url: string | null;
  rawStateValue: string | null; // the raw status-property value — core maps it to a canonical state (D4)
  ownerRef: string | null; // created_by, for digest recipient resolution
  lastEditedTime: string;
}

/**
 * The doc-layer seam, beside SourceConnector — Slack/Jira connections aren't forced to implement it.
 * ComposioConnector (notion) and StubConnector do (D9).
 */
export interface DocumentConnector {
  listDocuments(containerRef: string, statusProperty: string | null): Promise<DocMeta[]>;
  fetchDocumentSections(pageId: string): Promise<DocSection[]>;
  writeComment(pageId: string, body: string, anchorBlockId?: string | null): Promise<{ commentRef: string }>;
}

/** Duck-type check — lets the sweep loop skip the doc phase for connectors that can't do documents. */
export function isDocumentConnector(c: unknown): c is DocumentConnector {
  const o = c as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o.listDocuments === "function" &&
    typeof o.fetchDocumentSections === "function" &&
    typeof o.writeComment === "function"
  );
}
