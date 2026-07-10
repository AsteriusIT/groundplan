import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// The `drizzle/` folder sits at the backend package root, two levels up from
// this module in both dev (src/db) and build (dist/db) layouts.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Apply all pending migrations, then release the connection. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
