import "dotenv/config";

import { loadEnv } from "../config/env.js";
import { runMigrations } from "./migrate.js";

// Standalone entry for `pnpm migrate`. Applies pending migrations and exits.
try {
  await runMigrations(loadEnv().databaseUrl);
  console.info("✔ migrations applied");
  process.exit(0);
} catch (err: unknown) {
  console.error("✖ migration failed:", err);
  process.exit(1);
}
