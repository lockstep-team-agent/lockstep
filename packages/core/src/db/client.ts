import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { env } from "../env.js";

// Single pooled connection. The app connects as the owner but SET ROLEs into
// `lockstep_app` per request (see rls.ts) so Row-Level Security is enforced.
export const queryClient = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
