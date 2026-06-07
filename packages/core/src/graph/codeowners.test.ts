import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegex, parseCodeowners, resolveOwners } from "./codeowners.js";

const matches = (pattern: string, path: string): boolean => new RegExp(globToRegex(pattern)).test(path);

test("anchored directory matches its subtree only", () => {
  assert.ok(matches("/product-service/", "product-service/catalog.ts"));
  assert.ok(!matches("/product-service/", "order-service/orders.ts"));
});

test("extension glob matches at any depth", () => {
  assert.ok(matches("*.ts", "a/b/c.ts"));
  assert.ok(!matches("*.ts", "a/b/c.js"));
});

test("catch-all matches everything", () => {
  assert.ok(matches("*", "anything/here.go"));
});

test("interior slash anchors to root", () => {
  assert.ok(matches("docs/*", "docs/readme.md"));
  assert.ok(!matches("docs/*", "src/docs/readme.md"));
});

test("parse strips @ and comments, keeps order", () => {
  const rules = parseCodeowners("# header\n*            @naman\n/shared/   @naman @friend\n");
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0]!.owners, ["naman"]);
  assert.deepEqual(rules[1]!.owners, ["naman", "friend"]);
});

test("resolveOwners: last matching rule wins", () => {
  const rules = parseCodeowners("*        @naman\n*.md     @docs\n");
  assert.deepEqual(resolveOwners(rules, "README.md"), ["docs"]);
  assert.deepEqual(resolveOwners(rules, "main.ts"), ["naman"]);
});
