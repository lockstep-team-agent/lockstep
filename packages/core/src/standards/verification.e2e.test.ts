/**
 * Regression tests for the 2026-09-26 fix verification (F1–F6).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { withOrg, withSystem } from "../db/rls.js";
import { concepts, conceptPlacements, decisionVersions, decisions, domains, graphEdges, graphNodes, surfaces } from "../db/schema.js";
import { MemoryBlobStore, setBlobStore } from "../storage/blob.js";
import { saveNativeBrief } from "../adoption/native-documents.js";
import { createItem, getItem, previewVersion, publishVersion, saveDraft } from "./catalog.js";
import { storePackage } from "./packages.js";
import { applyChange, lockRolloutsTx, previewChange } from "./rollouts.js";
import { checkDocument } from "./checks.js";
import { decideException, requestException } from "./exceptions.js";
import { enc, one, setup, uid } from "./test-fixtures.js";

const flag = env as unknown as { LOCKSTEP_STANDARDS: boolean };
const prev = flag.LOCKSTEP_STANDARDS;
before(() => {
  setBlobStore(new MemoryBlobStore());
  flag.LOCKSTEP_STANDARDS = true;
});
after(() => {
  setBlobStore(null);
  flag.LOCKSTEP_STANDARDS = prev;
});
const pkg = async (orgId: string, body: string) => (await storePackage(orgId, [{ path: "SKILL.md", bytes: enc(`---\nname: x\n---\n${body}`) }], null)).id;

test("F1: Save & publish can't approve a package the admin didn't see", async () => {
  const s = await setup();
  const { itemId, versionId } = await createItem(s.orgId, s.eng, { kind: "skill", name: `imp ${uid()}`, content: {}, packageId: await pkg(s.orgId, "A") });
  // the admin opens the editor on package A
  const shown = { versionId, reviewHash: (await previewVersion(s.orgId, versionId)).version.reviewHash };
  // the author swaps in package B meanwhile
  await saveDraft(s.orgId, s.eng, itemId, { content: {}, packageId: await pkg(s.orgId, "B") });
  // the admin's Save & publish: a save with no files (imported/locked package), bound to what they saw
  await assert.rejects(saveDraft(s.orgId, s.cto, itemId, { content: {}, expected: shown }), /changed since you opened it/);
  // reopening shows B; saving + publishing that is what gets approved
  const now = { versionId, reviewHash: (await previewVersion(s.orgId, versionId)).version.reviewHash };
  const saved = await saveDraft(s.orgId, s.cto, itemId, { content: {}, expected: now });
  await publishVersion(s.orgId, s.cto, saved.versionId, saved.reviewHash);
  const v = (await getItem(s.orgId, itemId)).versions[0]!;
  assert.equal((await previewVersion(s.orgId, v.id)).skillMd?.includes("B"), true);
});

test("F2: a preview's impact and basis come from one state — a writer can't commit mid-preview", async () => {
  const s = await setup();
  const a = await createItem(s.orgId, s.cto, { kind: "skill", name: `a ${uid()}`, content: {}, packageId: await pkg(s.orgId, "a") });
  await publishVersion(s.orgId, s.cto, a.versionId);
  const b = await createItem(s.orgId, s.cto, { kind: "skill", name: `b ${uid()}`, content: {}, packageId: await pkg(s.orgId, "b") });
  await publishVersion(s.orgId, s.cto, b.versionId);
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [a.versionId], selectors: {}, level: "required" });
  const { enrollEnvironment } = await import("./environments.js");
  await enrollEnvironment({ orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, memberId: s.eng } as never, { adapter: "claude", hostKey: uid().toString(16).padStart(32, "0"), capabilities: { install: true } });

  // A second admin's revision (A → B) is mid-commit, holding the rollout lock.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let writerDone = false;
  const writer = withOrg(s.orgId, async (tx) => {
    await lockRolloutsTx(tx, s.orgId);
    const { assignments, assignmentRevisions, releases } = await import("../db/schema.js");
    const { releaseItemsTx } = await import("./applicability.js");
    const items = await releaseItemsTx(tx, s.orgId, [b.versionId]);
    const [rel] = await tx.insert(releases).values({ orgId: s.orgId, name: "B", items, releaseHash: "x" }).returning();
    const cur = one(await tx.select().from(assignments).where(eq(assignments.id, assignmentId!)));
    await tx.insert(assignmentRevisions).values({ orgId: s.orgId, assignmentId: assignmentId!, revision: cur.currentRevision + 1, releaseId: rel!.id, selectors: {}, level: "required", reason: "expand" });
    await tx.update(assignments).set({ currentRevision: cur.currentRevision + 1 }).where(eq(assignments.id, assignmentId!));
    await held;
    writerDone = true;
  });
  const preview = previewChange(s.orgId, s.cto, { kind: "retire", assignmentId: assignmentId! });
  await new Promise((r) => setTimeout(r, 150));
  release();
  await writer;
  const p = await preview;
  assert.ok(writerDone);
  // The preview waited for the writer: it shows removing B (the state its basis describes) …
  assert.deepEqual(p.rows[0]!.changes.map((c) => [c.action, c.name.slice(0, 1)]), [["remove", "b"]]);
  // … so applying with it retires exactly what was shown.
  await applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: assignmentId! }, p.basis);
});

test("F5: a section check links at most one requirement; exemption follows that requirement", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `PRD ${uid()}`, content: { taskTypes: ["prd"], requirements: [{ text: "Has metrics", level: "required" }, { text: "Has non-goals", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const [k1, k2] = ((await getItem(s.orgId, std.itemId)).versions[0]!.content as { requirements: Array<{ key: string }> }).requirements.map((r) => r.key);
  const both = await createItem(s.orgId, s.cto, { kind: "check", name: `both ${uid()}`, content: { artifactType: "prd", method: "structural", requiredSections: ["Success metrics"], requirementKeys: [k1, k2] } });
  await assert.rejects(publishVersion(s.orgId, s.cto, both.versionId), /at most one requirement/);
  const c1 = await createItem(s.orgId, s.cto, { kind: "check", name: `metrics ${uid()}`, content: { artifactType: "prd", method: "structural", requiredSections: ["Success metrics"], requirementKeys: [k1] } });
  await publishVersion(s.orgId, s.cto, c1.versionId);
  const c2 = await createItem(s.orgId, s.cto, { kind: "check", name: `nongoals ${uid()}`, content: { artifactType: "prd", method: "structural", requiredSections: ["Non-goals"], requirementKeys: [k2] } });
  await publishVersion(s.orgId, s.cto, c2.versionId);
  await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId, c1.versionId, c2.versionId], selectors: { projects: [s.projectId] }, level: "required" });
  const x = await requestException(s.orgId, s.eng, { target: "requirement", versionId: std.versionId, requirementKey: k1!, scope: { projectId: s.projectId }, reason: "exploratory" });
  await decideException(s.orgId, s.cto, x.id, true);
  const doc = await saveNativeBrief(s.orgId, s.projectId, s.cto, { title: "Thin", content: "## Scope\nx" }, async () => ({ rules: [], degraded: false }));
  const res = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId });
  const metrics = res.results.find((r) => r.checkVersionId === c1.versionId)!;
  const nongoals = res.results.find((r) => r.checkVersionId === c2.versionId)!;
  assert.deepEqual(metrics.findings.map((f) => [f.verdict, f.requirementKey]), [["exempt", k1]], "the exempt requirement is never flagged");
  assert.deepEqual(nongoals.findings.map((f) => [f.verdict, f.requirementKey]), [["possible_violation", k2]], "the other one still is, attributed correctly");
});

test("F6: binding capability rules govern a surface only through confirmed edges", async () => {
  const s = await setup();
  const { getConceptContracts } = await import("../concepts/read.js");
  const route = `http:GET /reports/${uid()}`;
  const ids = await withSystem(async (tx) => {
    const d = one(await tx.insert(domains).values({ orgId: s.orgId, projectId: s.projectId, key: `d${uid()}`, label: "Reports" }).returning());
    const c = one(await tx.insert(concepts).values({ orgId: s.orgId, projectId: s.projectId, key: `http:reports${uid()}`, label: "reports", domainId: d.id } as never).returning());
    const sf = one(await tx.insert(surfaces).values({ orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, surface: route, kind: "http" }).returning());
    await tx.insert(conceptPlacements).values({ orgId: s.orgId, projectId: s.projectId, itemKind: "surface", itemId: sf.id, location: "concept", conceptId: c.id, state: "confirmed" } as never);
    const sn = one(await tx.insert(graphNodes).values({ orgId: s.orgId, projectId: s.projectId, kind: "surface", ref: route }).returning());
    const confirmed = one(await tx.insert(graphNodes).values({ orgId: s.orgId, projectId: s.projectId, kind: "capability", ref: "cap:exports" }).returning());
    const proposed = one(await tx.insert(graphNodes).values({ orgId: s.orgId, projectId: s.projectId, kind: "capability", ref: "cap:billing" }).returning());
    await tx.insert(graphEdges).values({ orgId: s.orgId, projectId: s.projectId, fromId: confirmed.id, toId: sn.id, kind: "governs", status: "confirmed" });
    await tx.insert(graphEdges).values({ orgId: s.orgId, projectId: s.projectId, fromId: proposed.id, toId: sn.id, kind: "governs", status: "proposed" });
    for (const [ref, text] of [["cap:exports", "Exports finish in 30s"], ["cap:billing", "Bill monthly"]] as const) {
      const dd = one(await tx.insert(decisions).values({ orgId: s.orgId, projectId: s.projectId, scopeKind: "capability", scopeRef: ref, status: "binding", currentVersion: 1 }).returning());
      await tx.insert(decisionVersions).values({ orgId: s.orgId, decisionId: dd.id, version: 1, baseVersion: 0, ruleText: text, status: "binding" } as never);
    }
    return { conceptId: c.id, surfaceId: sf.id };
  });
  const r = await getConceptContracts(s.orgId, s.projectId, ids.conceptId);
  const row = r.contracts.find((x) => x.id === ids.surfaceId)!;
  assert.deepEqual(row.governing.map((g) => [g.ruleText, g.via]), [["Exports finish in 30s", "capability cap:exports"]], "a proposed edge confers no authority");
});
