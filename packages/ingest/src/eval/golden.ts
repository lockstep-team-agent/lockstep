/** Hand-labeled golden set for the extraction funnel (A.7). Grow this from review-queue rejects/edits. */
export interface GoldenExample {
  id: string;
  text: string;
  label: "decision" | "not";
}

export const GOLDEN: GoldenExample[] = [
  {
    id: "auth-jwt",
    label: "decision",
    text:
      "@alice: JWT or server-side sessions for auth?\n@bob: JWT keeps us stateless.\n@alice: agreed — locking it: JWT, 15-minute expiry, refresh via /auth/session. shipping it.",
  },
  {
    id: "bill-quarterly",
    label: "decision",
    text: "@carol: finance wants quarterly billing.\n@dave: fine by eng.\n@carol: decided — we bill quarterly, invoices in UTC as immutable snapshots.",
  },
  {
    id: "db-postgres",
    label: "decision",
    text: "@e: mongo or postgres for the new service?\n@f: postgres, we need transactions.\n@e: 👍 final call: Postgres for all new services.",
  },
  {
    id: "retry-idempotency",
    label: "decision",
    text: "@g: orders keep double-charging on retries.\n@h: going forward every order write MUST carry an idempotency key. that's the rule.",
  },
  {
    id: "lunch",
    label: "not",
    text: "@carol: anyone want lunch? cafeteria line is huge today lol",
  },
  {
    id: "status-update",
    label: "not",
    text: "@i: deployed the hotfix to staging, watching metrics. will update in an hour.",
  },
  {
    id: "still-debating",
    label: "not",
    text: "@j: should we use gRPC or REST between services?\n@k: gRPC is faster but REST is simpler.\n@j: hmm, let's think about it more and revisit next week.",
  },
  {
    id: "question-open",
    label: "not",
    text: "@l: does anyone know if the payments API supports partial refunds? need it for a customer.",
  },
  {
    id: "praise",
    label: "not",
    text: "@m: great work on the launch everyone 🎉 the dashboard looks amazing.",
  },
  {
    id: "naming-convention",
    label: "decision",
    text: "@n: our event names are all over the place.\n@o: let's standardize: all analytics events use snake_case, past tense (e.g. order_created). from now on.",
  },
  // ── 2026-09-18 Jev eval — cases the keyword prefilter or a token-matching filter gets wrong ──
  {
    id: "no-marker-words",
    label: "decision",
    text: "@dev: the mobile crashes were the enum. new fields on the Order response are additive only, nobody removes or renames a field without a v2 path.\n@priya: yep. that's how it is now.\n@arjun: ack, noting it in the api guide",
  },
  {
    id: "manager-decree",
    label: "decision",
    text: "@cto: Effective immediately all customer PII columns are encrypted at rest with the KMS key per tenant. No exceptions. Details in the security doc.\n@dev: 👀\n@arjun: 👍",
  },
  {
    id: "hinglish-final",
    label: "decision",
    text: "@priya: toh final: sab payment calls billing-service ke through hi jayenge, direct Stripe SDK kahin nahi. theek?\n@dev: haan done, agreed\n@arjun: ok, removing the direct calls from checkout",
  },
  {
    id: "sarcastic-locked-in",
    label: "not",
    text: "@dev: great, so we've 'locked in' that the build breaks every friday\n@arjun: it's a standard at this point\n@priya: 💀",
  },
  {
    id: "reverted-in-thread",
    label: "not",
    text: "@priya: let's go with Redis for the rate limiter, agreed?\n@dev: agreed\n@arjun: wait, infra says no new managed services this quarter\n@priya: ugh ok scrap that, back to the drawing board",
  },
  {
    id: "personal-not-team",
    label: "not",
    text: "@dev: I've decided I'm going to use vim for the rest of the sprint\n@arjun: bold\n@priya: report back",
  },
  {
    id: "standup-time",
    label: "not",
    text: "@priya: we decided to push standup to 10:30 tomorrow\n@dev: agreed, works for me\n@arjun: 👍",
  },
  {
    id: "fact-not-decision",
    label: "not",
    text: "@dev: what's our token expiry?\n@arjun: 15 min, it's in the auth ADR\n@dev: cool thanks",
  },
];
