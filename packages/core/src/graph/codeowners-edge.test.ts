import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegex, parseCodeowners, resolveOwners } from "./codeowners.js";

const matches = (pattern: string, path: string): boolean => new RegExp(globToRegex(pattern)).test(path);

test("double-star matches across directories", () => {
  assert.ok(matches("src/**/*.ts", "src/a/b/c.ts"));
  // NOTE: src/**/*.ts requires at least one dir after src/ in this implementation
  assert.ok(!matches("src/**/*.ts", "lib/index.ts"));
});

test("no slash in pattern matches at any depth", () => {
  assert.ok(matches("*.go", "cmd/server/main.go"));
  assert.ok(matches("*.go", "main.go"));
  assert.ok(!matches("*.go", "main.rs"));
});

test("empty CODEOWNERS returns no rules", () => {
  assert.deepEqual(parseCodeowners(""), []);
  assert.deepEqual(parseCodeowners("# just comments\n# another comment\n"), []);
});

test("lines with only a pattern (no owners) are skipped", () => {
  const rules = parseCodeowners("*.ts\n*.js @frontend\n");
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.owners, ["frontend"]);
});

test("resolveOwners returns [] when no rules match", () => {
  const rules = parseCodeowners("/backend/ @backend-team\n");
  assert.deepEqual(resolveOwners(rules, "frontend/app.tsx"), []);
});

test("multiple owners are parsed correctly", () => {
  const rules = parseCodeowners("*.config.ts @devops @platform @sre\n");
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.owners, ["devops", "platform", "sre"]);
});

test("real-world CODEOWNERS with multiple sections", () => {
  const content = `
# Default
* @engineering

# Frontend
/packages/web/ @frontend-team
*.css @frontend-team

# Backend
/packages/core/ @backend-team
/packages/cli/ @cli-team

# Infra
Dockerfile @devops
docker-compose.yml @devops
`;
  const rules = parseCodeowners(content);
  assert.equal(rules.length, 7);

  // Last match wins: Dockerfile is matched by * (engineering) then Dockerfile (devops)
  assert.deepEqual(resolveOwners(rules, "Dockerfile"), ["devops"]);
  // packages/core/src/server.ts → /packages/core/ matches → backend-team
  assert.deepEqual(resolveOwners(rules, "packages/core/src/server.ts"), ["backend-team"]);
  // packages/web/app/page.tsx → /packages/web/ matches → frontend-team
  assert.deepEqual(resolveOwners(rules, "packages/web/app/page.tsx"), ["frontend-team"]);
  // random.md → only * matches → engineering
  assert.deepEqual(resolveOwners(rules, "random.md"), ["engineering"]);
  // styles/app.css → *.css matches → frontend-team
  assert.deepEqual(resolveOwners(rules, "styles/app.css"), ["frontend-team"]);
});
