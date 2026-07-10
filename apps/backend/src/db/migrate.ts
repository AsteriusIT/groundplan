import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// The `drizzle/` folder sits at the backend package root, two levels up from
// this module in both dev (src/db) and build (dist/db) layouts.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

// Arbitrary constant so concurrent migrators (parallel test files, multiple app
// instances starting at once) serialize instead of racing on CREATE TABLE/TYPE.
const MIGRATION_ADVISORY_LOCK = 0x67706d67; // "gpmg"

/** Apply all pending migrations under an advisory lock, then release. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const lockClient = await pool.connect();
    try {
      await lockClient.query("SELECT pg_advisory_lock($1)", [
        MIGRATION_ADVISORY_LOCK,
      ]);
      await migrate(drizzle(pool), { migrationsFolder });
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [
        MIGRATION_ADVISORY_LOCK,
      ]);
      lockClient.release();
    }
  } finally {
    await pool.end();
  }
}
