import postgres from "postgres";
import { env } from "../env.js";

/**
 * Wipe ALL application data from the target database. Preserves schema, the lockstep_app
 * role, RLS policies, and append-only triggers — only the rows go. Guarded by --yes.
 *
 * Usage (point at the target DB):
 *   DATABASE_URL="<url>" npm run db:reset -w @lockstep/core -- --yes
 */
async function main(): Promise<void> {
  const masked = env.DATABASE_URL.replace(/:[^:@/]+@/, ":****@");
  if (!process.argv.includes("--yes")) {
    console.error("This permanently wipes ALL data in the target database:");
    console.error(`  ${masked}`);
    console.error("Re-run with --yes to confirm.");
    process.exit(1);
  }
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  try {
    await sql.unsafe(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '%drizzle%') LOOP
          EXECUTE format('TRUNCATE TABLE %I RESTART IDENTITY CASCADE', r.tablename);
        END LOOP;
      END $$;`);
    console.log(`✓ all application data wiped at ${masked} (schema, roles & policies preserved).`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
