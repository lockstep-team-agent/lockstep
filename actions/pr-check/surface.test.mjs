/** The vendored canonicalizer must produce the SAME refs the ledger stores (see packages/cli surface.test.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSurfaces, isContractSurface } from "./surface.mjs";

test("express/fastify route literals → http:METHOD /path", () => {
  const c = `const router = express.Router(); router.post("/payments/init", h); app.get('/health', h);`;
  const s = extractSurfaces("src/routes/payments.ts", c);
  assert.ok(s.includes("http:POST /payments/init"));
  assert.ok(s.includes("http:GET /health"));
});

test("next app-router route → http:METHOD /path (route groups + [id] normalized)", () => {
  const s = extractSurfaces("app/(shop)/checkout/[id]/route.ts", "export async function POST() {}");
  assert.deepEqual(s, ["http:POST /checkout/:id"]);
});

test("proto service/rpc → proto:pkg.Service/Rpc", () => {
  const c = `package pay.v1;\nservice Payments { rpc Init (R) returns (S); }`;
  assert.deepEqual(extractSurfaces("pay.proto", c), ["proto:pay.v1.Payments/Init"]);
});

test("graphql root fields → gql:Root.field", () => {
  const c = `type Mutation { pay(x: Int): P\n login: T }`;
  const s = extractSurfaces("schema.graphql", c);
  assert.ok(s.includes("gql:Mutation.pay") && s.includes("gql:Mutation.login"));
});

test("non-route files define no surface (ledger stays quiet)", () => {
  assert.deepEqual(extractSurfaces("src/util/math.ts", "export const add = (a,b)=>a+b;"), []);
});

test("isContractSurface pre-filter", () => {
  assert.ok(isContractSurface("src/routes/x.ts"));
  assert.ok(isContractSurface("api/openapi.yaml"));
  assert.ok(isContractSurface("x.proto"));
  assert.ok(!isContractSurface("src/util/math.ts"));
});
