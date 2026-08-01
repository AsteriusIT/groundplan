/**
 * The extraction worker's loop (GP-236).
 *
 * The default run proves the postures that must hold on any machine: a
 * disabled deployment makes no call at all, and a pass that throws does not take
 * the worker down. The end-to-end case — a real provider, really downloaded,
 * really written into Postgres — is the story's acceptance criterion and runs
 * under `CATALOG_E2E=1`, which CI sets.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { catalogProviders } from "../db/schema.js";
import { catalogRepository } from "./repository.js";
import { runOnce, runWorker, type WorkerLog } from "./worker.js";

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const repo = catalogRepository(drizzle(pool));

before(async () => {
  await runMigrations(env.databaseUrl);
});

function silentLog(): WorkerLog & { warnings: unknown[]; errors: unknown[] } {
  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  return {
    warnings,
    errors,
    info: () => {},
    warn: (obj) => warnings.push(obj),
    error: (obj) => errors.push(obj),
  };
}

describe("catalog worker (GP-236)", () => {
  test("a disabled deployment extracts nothing and says so", async () => {
    const log = silentLog();
    const outcomes = await runOnce({
      env: { ...env, catalogRefresh: "disabled" } satisfies AppEnv,
      pool,
      log,
    });
    assert.deepEqual(outcomes, []);
    assert.equal(log.warnings.length, 1);
  });

  test("a pass that throws is logged, and the worker keeps its process", async () => {
    const log = silentLog();
    // A database nobody can reach: `runOnce` throws inside the loop. `.invalid`
    // is the reserved TLD (RFC 2606), so this fails at DNS and never waits on a
    // socket somebody's network might swallow.
    await runWorker({
      env: {
        ...env,
        databaseUrl: "postgres://nobody@catalog.invalid:5432/none",
        catalogProviders: "hashicorp/random",
      } satisfies AppEnv,
      once: true,
      log,
    });
    assert.equal(log.errors.length, 1, "the failure is reported, not thrown");
  });
});

describe(
  "end to end into Postgres (GP-236)",
  { skip: process.env.CATALOG_E2E !== "1" },
  () => {
    test("a real provider is extracted and becomes readable", async () => {
      // A namespace of its own so the run cannot collide with a real catalog
      // row, but the *name* is the real provider — this genuinely downloads
      // `hashicorp/random` and asks it to describe itself.
      const ref = { namespace: "hashicorp", name: "random" };
      try {
        const outcomes = await runOnce({
          env: {
            ...env,
            catalogProviders: "hashicorp/random",
            catalogRefresh: "auto",
            catalogTtlMs: 0,
          } satisfies AppEnv,
          pool,
          log: silentLog(),
        });
        assert.equal(outcomes.length, 1);
        assert.ok(
          outcomes[0]?.action === "extracted" ||
            outcomes[0]?.action === "up_to_date",
          `unexpected outcome: ${JSON.stringify(outcomes[0])}`,
        );

        const ready = await repo.getLatestReadyVersion(ref);
        assert.ok(ready, "the provider must be servable after a pass");

        const types = await repo.listResourceTypes(ready.versionId, {
          limit: 100,
        });
        assert.ok(types.items.some((t) => t.type === "random_password"));

        const schema = await repo.getResourceSchema(
          ready.versionId,
          "random_password",
        );
        assert.equal(
          schema?.attributes.find((a) => a.name === "result")?.sensitive,
          true,
        );
        assert.equal(schema?.provider, "hashicorp/random");
      } finally {
        // The row is real (`hashicorp/random` is a real provider), so it is
        // left in place only when this deployment allowlists it; otherwise the
        // test cleans up after itself.
        if (!env.catalogProviders.includes("hashicorp/random")) {
          await drizzle(pool)
            .delete(catalogProviders)
            .where(eq(catalogProviders.name, "random"));
        }
      }
    });
  },
);
