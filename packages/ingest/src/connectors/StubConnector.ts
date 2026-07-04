import type { SourceConnector, Unit, Channel } from "./SourceConnector.js";

/** Canned data for deterministic tests and local demos — no network, no Composio, no Slack app. */
export class StubConnector implements SourceConnector {
  constructor(private readonly units: Unit[] = StubConnector.sample()) {}

  async listChannels(): Promise<Channel[]> {
    return [{ id: "C_STUB", name: "eng-decisions" }];
  }

  async listUnitsSince(sourceRef: string, _sinceCursor: string | null): Promise<Unit[]> {
    return this.units.filter((u) => u.sourceRef === sourceRef);
  }

  static sample(): Unit[] {
    return [
      {
        externalId: "C_STUB/1699000001.0001",
        sourceRef: "C_STUB",
        sourceName: "eng-decisions",
        ts: "1699000001.0001",
        authors: ["@alice", "@bob"],
        permalink: "https://example.slack.com/archives/C_STUB/p16990000010001",
        text:
          "@alice: should auth tokens be JWT or server-side sessions?\n" +
          "@bob: JWT keeps us stateless across services. I say JWT, 15-min expiry.\n" +
          "@alice: agreed — let's lock it: JWT with 15-minute expiry, refresh via /auth/session. Shipping it.",
      },
      {
        externalId: "C_STUB/1699000002.0002",
        sourceRef: "C_STUB",
        sourceName: "eng-decisions",
        ts: "1699000002.0002",
        authors: ["@carol"],
        permalink: "https://example.slack.com/archives/C_STUB/p16990000020002",
        text: "@carol: anyone grabbing lunch? the cafeteria line is huge today lol",
      },
    ];
  }
}
