/**
 * The unmatched-call → teammate mapping. `gitAuthors` is injected so these stay pure: no repo,
 * no network, and the noreply-handle parsing is asserted directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestInvites, renderInvites } from "./invites.js";

const UNMATCHED = [
  { ref: "https://auth.acme.com/session", via: "fetch", file: "src/clients/auth.ts" },
  { ref: "https://billing.acme.com/customers", via: "fetch", file: "src/clients/billing.ts" },
];
const LOG: Record<string, string[]> = {
  "src/clients/auth.ts": ["Marco Diaz\t1234+dev-marco@users.noreply.github.com", "Priya R\tpriya@acme.com"],
  "src/clients/billing.ts": ["Lin Wu\tlin@acme.com"],
};
const authors = (_cwd: string, file: string): string[] => LOG[file] ?? [];

test("a noreply email yields the GitHub handle; other authors fall back to their name", () => {
  const s = suggestInvites(".", UNMATCHED, [], authors);
  assert.deepEqual(
    s.map((x) => [x.file, x.handles]),
    [
      ["src/clients/auth.ts", ["dev-marco", "Priya R"]],
      ["src/clients/billing.ts", ["Lin Wu"]],
    ],
  );
});

test("excluded identities are dropped by handle, name or email, case-insensitively", () => {
  const s = suggestInvites(".", UNMATCHED, ["PRIYA@acme.com", "lin wu"], authors);
  assert.deepEqual(s.map((x) => x.handles), [["dev-marco"]], "billing drops out once its only author is excluded");
});

test("a call with no file, or a file with no history, suggests nobody", () => {
  assert.deepEqual(suggestInvites(".", [{ ref: "x", via: "fetch" }], [], authors), []);
  assert.deepEqual(suggestInvites(".", [{ ref: "x", via: "fetch", file: "untouched.ts" }], [], authors), []);
});

test("at most two handles per surface, and duplicates collapse", () => {
  const many = (_c: string, _f: string) => ["A\ta@x.com", "B\tb@x.com", "A\ta@x.com", "C\tc@x.com"];
  const s = suggestInvites(".", [{ ref: "r", via: "fetch", file: "f.ts" }], [], many);
  assert.deepEqual(s[0]!.handles, ["A", "B"]);
});

test("the footer names the count, each file, and one runnable invite command", () => {
  const text = renderInvites(suggestInvites(".", UNMATCHED, [], authors), 2);
  assert.match(text, /depends on 2 surfaces nobody has declared yet/);
  assert.ok(text.includes("src/clients/auth.ts"));
  assert.ok(text.includes("@dev-marco"));
  assert.match(text, /lockstep invite dev-marco Priya R Lin Wu/);
});

test("nothing to suggest → no footer at all", () => {
  assert.equal(renderInvites([], 3), "");
});
