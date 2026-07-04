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
];
