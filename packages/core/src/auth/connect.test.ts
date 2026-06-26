/**
 * Connect/invite regression test — the cross-service teammate flow that previously failed silently:
 * a teammate with a *different* repo could only land in the right project via an invite, and the
 * status returned was misleading ("created" even when joining). Runs against a real Postgres.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { devLogin, connectOrJoin, invite, listMemberships } from "./auth-service.js";
import { orgOverview } from "../dashboard/dashboard-service.js";
import type { Principal } from "./tokens.js";

let seq = Date.now();
const uid = (): number => ++seq;

async function login(handle: string): Promise<Principal> {
  const id = uid();
  const out = await devLogin(id, `${handle}-${id}`);
  return { id: out.principalId, githubUserId: id, githubLogin: out.githubLogin };
}

test("solo connect with no invite creates a new workspace (and flags it)", async () => {
  const pat = await login("pat");
  const r = await connectOrJoin(pat, `github.com/co/svc-${uid()}.git`, "teamX");
  assert.equal(r.status, "created");
  assert.equal(r.createdOrg, true, "brand-new workspace → CLI should warn about accidental-solo");
});

test("a second dev with a DIFFERENT repo only joins after an invite", async () => {
  const producer = await login("producer");
  const project = `proj-${uid()}`;
  const created = await connectOrJoin(producer, `github.com/co/producer-${uid()}.git`, project);
  assert.equal(created.status, "created");

  // Without an invite, a different repo lands in its OWN workspace — not the producer's.
  const stranger = await login("stranger");
  const solo = await connectOrJoin(stranger, `github.com/co/stranger-${uid()}.git`, project);
  assert.equal(solo.createdOrg, true);
  assert.notEqual(solo.orgId, created.orgId, "no invite → separate workspace (the gap we now warn about)");

  // With an invite (activated on the consumer's next login), the consumer JOINS the producer's project.
  await invite(producer, created.orgId, created.projectId, "consumer-handle");
  const consumer = await login2("consumer-handle"); // login with the exact invited handle
  const joined = await connectOrJoin(consumer, `github.com/co/consumer-${uid()}.git`, project);
  assert.equal(joined.status, "joined");
  assert.equal(joined.createdOrg, false);
  assert.equal(joined.orgId, created.orgId, "invited teammate lands in the producer's workspace");
});

test("orgOverview exposes each project's repo remotes (so `lockstep invite` can resolve the project)", async () => {
  const dev = await login("dev");
  const remote = `github.com/co/over-${uid()}.git`;
  const r = await connectOrJoin(dev, remote, `ovproj-${uid()}`);
  const ov = await orgOverview(r.orgId);
  const proj = ov.projects.find((p) => p.id === r.projectId);
  assert.ok(proj, "project present in overview");
  assert.ok(
    proj!.repos.some((rp) => rp.gitRemote === remote),
    "the connected repo's remote is listed under its project",
  );
});

// The invite is keyed on the exact GitHub handle; this test needs a principal whose handle matches
// the invited string verbatim (not the uid-suffixed helper).
async function login2(handle: string): Promise<Principal> {
  const id = uid();
  const out = await devLogin(id, handle);
  return { id: out.principalId, githubUserId: id, githubLogin: out.githubLogin };
}
