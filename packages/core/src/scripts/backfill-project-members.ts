/**
 * #2 one-off backfill: ensure every existing project has an authoritative owner row in
 * project_members. Before this, only invited users got project_members rows — creators/auto-joiners
 * relied on org-wide (shared) visibility. When an owner later flips a project to "walled", reads gate
 * on project_members, so the creator must already appear there or they'd be locked out of their own
 * project. This backfills the project's `createdBy` member as an active owner. Idempotent
 * (onConflictDoNothing on the (project_id, invited_github_login) unique index) — safe to re-run.
 *
 * NOTE: this backfills the CREATOR only. Walling an existing project still requires the owner to
 * invite the other members who should have access — that's the intended, explicit walling step.
 *
 * Run: `tsx src/scripts/backfill-project-members.ts` (DATABASE_URL set).
 */
import { eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { projects, members, projectMembers } from "../db/schema.js";

async function main(): Promise<void> {
  const filled = await withSystem(async (tx) => {
    const ps = await tx.select().from(projects);
    let n = 0;
    for (const p of ps) {
      if (!p.createdBy) continue;
      const owner = (await tx.select().from(members).where(eq(members.id, p.createdBy)).limit(1))[0];
      if (!owner) continue;
      const res = await tx
        .insert(projectMembers)
        .values({
          orgId: p.orgId,
          projectId: p.id,
          memberId: owner.id,
          invitedGithubLogin: owner.githubLogin,
          role: "owner",
          status: "active",
        })
        .onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.invitedGithubLogin] })
        .returning();
      n += res.length;
    }
    return n;
  });
  // eslint-disable-next-line no-console
  console.log(`backfill-project-members: inserted ${filled} owner row(s)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  },
);
