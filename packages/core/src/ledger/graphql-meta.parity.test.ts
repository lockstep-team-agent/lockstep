/**
 * Pins core's GraphQL metadata parser to the CLI copy (both KEEP IN SYNC), and pins the parse on
 * the hard cases: multiline fields and args, nested lists, nullability, every type category, a type
 * defined in another document, a type absent altogether, and a return type that changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGraphqlMeta } from "./graphql-meta.js";

// Outside core's rootDir, so loaded dynamically (same pattern as surface-extract.parity.test.ts).
const cliPath = "../../../cli/src/capture/graphql-meta.ts";
const { resolveGraphqlMeta: cliResolve } = (await import(cliPath)) as { resolveGraphqlMeta: typeof resolveGraphqlMeta };

const SCHEMA = `
"""The root query"""
type Query {
  # a comment: fake(x: Int): Nope
  order(id: ID!): Order
  orders(
    first: Int
    after: String
  ): [Order!]!
  matrix: [[Cell!]!]
  status: Status @deprecated(reason: "use state")
  shape: Shape
  total: Money
  me: Viewer
  ghost: Phantom
  health: Boolean!
}
extend type Mutation {
  createOrder(input: OrderInput!): CreateOrderPayload
}
type Order { id: ID! }
type Cell { v: Int }
enum Status { OPEN CLOSED }
union Shape = Order | Cell
scalar Money
input OrderInput { id: ID }
type CreateOrderPayload { order: Order }
`;
const OTHER = `interface Viewer { id: ID! }`;

const expected: Record<string, [string, string]> = {
  "gql:Query.order": ["Order", "object"],
  "gql:Query.orders": ["[Order!]!", "object"],
  "gql:Query.matrix": ["[[Cell!]!]", "object"],
  "gql:Query.status": ["Status", "enum"],
  "gql:Query.shape": ["Shape", "union"],
  "gql:Query.total": ["Money", "scalar"],
  "gql:Query.me": ["Viewer", "interface"],
  "gql:Query.ghost": ["Phantom", "unknown"],
  "gql:Query.health": ["Boolean!", "scalar"],
  "gql:Mutation.createOrder": ["CreateOrderPayload", "object"],
};

test("graphql metadata: hard cases resolve across documents", () => {
  const got = resolveGraphqlMeta([SCHEMA, OTHER]);
  assert.equal(got.size, Object.keys(expected).length, [...got.keys()].join(","));
  for (const [surface, [rt, kind]] of Object.entries(expected)) {
    assert.deepEqual(got.get(surface), { returnType: rt, returnTypeKind: kind }, surface);
  }
});

test("graphql metadata: a changed return type re-resolves its category", () => {
  const v2 = SCHEMA.replace("status: Status", "status: Order");
  assert.equal(resolveGraphqlMeta([v2]).get("gql:Query.status")?.returnTypeKind, "object");
});

test("graphql metadata: CLI and core copies agree", () => {
  for (const docs of [[SCHEMA, OTHER], [SCHEMA], [OTHER], [""]]) {
    assert.deepEqual([...resolveGraphqlMeta(docs)], [...cliResolve(docs)]);
  }
});
