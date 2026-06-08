import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, "../../drizzle");
const sqlDir = path.resolve(here, "../../sql");

/**
 * Boot-time migration: apply Drizzle-generated table migrations, then the custom
 * RLS + append-only SQL. Runs on `core` startup (self-host friendly) and via `npm run db:migrate`.
 */
async function main(): Promise<void> {
  const client = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);
  try {
    if (existsSync(path.join(drizzleDir, "meta", "_journal.json"))) {
      console.log("[migrate] applying Drizzle migrations…");
      await migrate(db, { migrationsFolder: drizzleDir });
    } else {
      console.warn("[migrate] no Drizzle migrations found — run `npm run db:generate -w @lockstep/core` first.");
      process.exit(1);
    }
    for (const file of ["0001_rls.sql", "0002_append_only.sql"]) {
      const p = path.join(sqlDir, file);
      if (existsSync(p)) {
        console.log(`[migrate] applying ${file}…`);
        await client.unsafe(readFileSync(p, "utf8"));
      }
    }
    console.log("[migrate] done.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
