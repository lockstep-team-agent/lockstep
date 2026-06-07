/* DB-backed verification of the ownership graph (run via tsx with DATABASE_URL set). */
import { withSystem } from "../db/rls.js";
import { orgs, repos } from "../db/schema.js";
import { refreshOwnership, whoowns } from "../graph/ownership-service.js";

const CODEOWNERS = `
# Shopify monorepo
*                     @naman
/product-service/     @friend
/order-service/       @naman
/shared/contracts/    @naman @friend
*.md                  @docs
`;

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

async function main(): Promise<void> {
  const { orgId, repoId } = await withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: "T" }).returning());
    const repo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: org.id, gitRemote: "github.com/x/mono", isMonorepo: true })
        .returning(),
    );
    return { orgId: org.id, repoId: repo.id };
  });

  await refreshOwnership(orgId, repoId, CODEOWNERS, "sha-1");

  const cases: Array<[string, string[]]> = [
    ["product-service/catalog.ts", ["friend"]],
    ["order-service/orders.ts", ["naman"]],
    ["shared/contracts/openapi.yaml", ["naman", "friend"]],
    ["README.md", ["docs"]], // *.md (later) beats * (earlier)
    ["random/file.go", ["naman"]], // only the catch-all matches
  ];

  let ok = true;
  for (const [path, expected] of cases) {
    const owners = await whoowns(orgId, repoId, path);
    const pass = JSON.stringify([...owners].sort()) === JSON.stringify([...expected].sort());
    console.log(`${pass ? "✅" : "❌"} whoowns(${path}) = [${owners}]  (expected [${expected}])`);
    if (!pass) ok = false;
  }
  process.exit(ok ? 0 : 1);
}

void main();
