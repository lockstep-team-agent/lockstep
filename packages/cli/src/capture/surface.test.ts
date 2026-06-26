import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSurfaces } from "./surface.js";

test("extracts Express/Fastify routes as canonical http IDs", () => {
  const ids = extractSurfaces("src/routes/auth.ts", `router.post('/auth/session', login)\napp.get("/auth/me", me)`);
  assert.deepEqual(ids.sort(), ["http:GET /auth/me", "http:POST /auth/session"]);
});

test("normalizes path params and casing", () => {
  const ids = extractSurfaces("src/routes/users.ts", "router.GET('/users/{id}/', show)");
  assert.deepEqual(ids, ["http:GET /users/:id"]);
});

test("producer and consumer derive the SAME id for the same endpoint", () => {
  const producer = extractSurfaces("services/auth/src/routes/session.ts", "app.post('/auth/session', h)");
  // A consumer would declare this exact string in lockstep.yaml — they must match.
  assert.equal(producer[0], "http:POST /auth/session");
});

test("Next.js app-router route file", () => {
  const ids = extractSurfaces("app/auth/session/route.ts", "export async function POST(req) {}\nexport function GET() {}");
  assert.deepEqual(ids.sort(), ["http:GET /auth/session", "http:POST /auth/session"]);
});

test("Next.js dynamic + route-group segments", () => {
  const ids = extractSurfaces("app/(marketing)/users/[id]/route.ts", "export async function GET() {}");
  assert.deepEqual(ids, ["http:GET /users/:id"]);
});

test("protobuf service/rpc with package", () => {
  const ids = extractSurfaces(
    "proto/auth.proto",
    "package auth.v1;\nservice AuthService {\n  rpc Login (Req) returns (Res);\n  rpc Logout (Req) returns (Res);\n}",
  );
  assert.deepEqual(ids.sort(), ["proto:auth.v1.AuthService/Login", "proto:auth.v1.AuthService/Logout"]);
});

test("graphql root fields", () => {
  const ids = extractSurfaces("schema.graphql", "type Mutation {\n  login(x: String): Token\n}");
  assert.deepEqual(ids, ["gql:Mutation.login"]);
});

test("a non-interface file yields no surfaces", () => {
  assert.deepEqual(extractSurfaces("src/util.ts", "export function add(a,b){return a+b}"), []);
  assert.deepEqual(extractSurfaces("README.md", "# hi"), []);
});
