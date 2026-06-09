import { and, eq } from "drizzle-orm";
import { members, dependencyEdges, repos, inboxes, inboxItems } from "../db/schema.js";
import type { Tx } from "../db/rls.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

async function ensureInbox(
  tx: Tx,
  orgId: string,
  memberId: string,
  repoId: string,
  projectId: string,
): Promise<string> {
  const existing = (
    await tx
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.memberId, memberId), eq(inboxes.repoId, repoId), eq(inboxes.projectId, projectId)))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  return one(await tx.insert(inboxes).values({ orgId, memberId, repoId, projectId }).returning()).id;
}

export interface FanoutArgs {
  projectId: string;
  changeId: string;
  surface: string;
  senderRepoId: string;
  senderMemberId: string;
}

/**
 * Fan a published change out to the inboxes of repos that CONSUME the changed surface
 * (dependency graph), excluding the sender. Delivered into each recipient's
 * (member, consumer-repo, project) inbox. Runs in the caller's transaction.
 */
export async function fanoutChangeTx(tx: Tx, orgId: string, args: FanoutArgs): Promise<number> {
  const edges = await tx
    .select()
    .from(dependencyEdges)
    .where(and(eq(dependencyEdges.producedSurface, args.surface), eq(dependencyEdges.active, true)));
  const consumerRepos = [...new Set(edges.map((e) => e.consumerRepoId))].filter((r) => r !== args.senderRepoId);
  if (consumerRepos.length === 0) return 0;

  const orgMembers = await tx.select().from(members).where(eq(members.orgId, orgId));
  let delivered = 0;
  for (const repoId of consumerRepos) {
    for (const m of orgMembers) {
      if (m.id === args.senderMemberId) continue;
      const inboxId = await ensureInbox(tx, orgId, m.id, repoId, args.projectId);
      await tx
        .insert(inboxItems)
        .values({
          orgId,
          inboxId,
          kind: "change",
          refId: args.changeId,
          reason: { surface: args.surface, consumerRepoId: repoId },
        })
        .onConflictDoNothing();
      delivered++;
    }
  }
  return delivered;
}

export interface ProjectFanoutArgs {
  projectId: string;
  refId: string;
  kind: "question" | "task";
  senderMemberId: string;
  reason?: unknown;
  /** For tasks: deliver only to this member (if set). */
  targetMemberId?: string | null;
}

/**
 * Fan a question or task out to all project members' inboxes (excluding the sender).
 * Each member gets one item per repo they're connected to in the project.
 * For tasks with a specific delegatee, delivers only to that member.
 */
export async function fanoutToProjectTx(tx: Tx, orgId: string, args: ProjectFanoutArgs): Promise<number> {
  const projectRepos = await tx.select().from(repos).where(eq(repos.projectId, args.projectId));
  if (projectRepos.length === 0) return 0;

  const orgMembers = await tx.select().from(members).where(eq(members.orgId, orgId));
  const targets = args.targetMemberId
    ? orgMembers.filter((m) => m.id === args.targetMemberId)
    : orgMembers.filter((m) => m.id !== args.senderMemberId);

  let delivered = 0;
  for (const m of targets) {
    for (const repo of projectRepos) {
      const inboxId = await ensureInbox(tx, orgId, m.id, repo.id, args.projectId);
      await tx
        .insert(inboxItems)
        .values({
          orgId,
          inboxId,
          kind: args.kind,
          refId: args.refId,
          reason: args.reason ?? null,
        })
        .onConflictDoNothing();
      delivered++;
    }
  }
  return delivered;
}
