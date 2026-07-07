/**
 * GitHub App installation recording (Phase 3). The account login is verified via an injected lookup
 * (real prod uses the App JWT), so a forged id can't attach. Idempotent per (org, installationId).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs } from "../db/schema.js";
import { recordInstallation, getInstallation } from "./ownership-service.js";

let seq = Date.now();
const uid = (): number => ++seq;

async function newOrg(): Promise<string> {
  return withSystem(async (tx) => {
    const r = (
      await tx
        .insert(orgs)
        .values({ name: `Install-${uid()}` })
        .returning()
    )[0];
    if (!r) throw new Error("no org");
    return r.id;
  });
}

test("recordInstallation stores + getInstallation reports installed", async () => {
  const orgId = await newOrg();
  assert.deepEqual(await getInstallation(orgId), { installed: false, accountLogin: null });
  const r = await recordInstallation(orgId, 4242, async () => "acme-corp");
  assert.deepEqual(r, { installationId: 4242, accountLogin: "acme-corp" });
  assert.deepEqual(await getInstallation(orgId), { installed: true, accountLogin: "acme-corp" });
});

test("recordInstallation is idempotent and refreshes the account login", async () => {
  const orgId = await newOrg();
  await recordInstallation(orgId, 99, async () => "old-login");
  await recordInstallation(orgId, 99, async () => "new-login");
  const got = await getInstallation(orgId);
  assert.equal(got.accountLogin, "new-login");
});
