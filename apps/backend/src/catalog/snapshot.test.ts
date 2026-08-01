/**
 * The bundled snapshot and the air-gapped path (GP-239).
 *
 * The story's promise is one sentence: a fresh install with
 * `CATALOG_REFRESH=disabled` and no network has the full builder. These tests
 * are that sentence — the round trip, the seeding, and the assertion that
 * nothing outbound is even attempted.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { catalogProviders } from "../db/schema.js";
import { AZURERM_SCHEMAS, AZURERM_VERSION } from "./__fixtures__/azurerm.js";
import { parseAllowlist, type ProviderRef } from "./providers.js";
import { catalogRepository } from "./repository.js";
import { seedFromSnapshot } from "./seed.js";
import {
  exportSnapshot,
  importSnapshot,
  packSnapshot,
  unpackSnapshot,
  SNAPSHOT_FORMAT,
  type CatalogSnapshot,
} from "./snapshot.js";

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const db = drizzle(pool);
const repo = catalogRepository(db);

before(async () => {
  await runMigrations(env.databaseUrl);
});

function uniqueRef(): ProviderRef {
  return {
    namespace: `test-${Date.now()}-${randomBytes(4).toString("hex")}`,
    name: "azurerm",
  };
}

async function cleanup(ref: ProviderRef): Promise<void> {
  await db
    .delete(catalogProviders)
    .where(eq(catalogProviders.namespace, ref.namespace));
}

async function seedReady(ref: ProviderRef) {
  const provider = await repo.ensureProvider(ref, { allowlisted: true });
  const version = await repo.ensureVersion(provider.id, AZURERM_VERSION);
  await repo.claimExtraction(version.id, new Date());
  await repo.saveSchemas(version.id, AZURERM_SCHEMAS, new Date());
}

/** A snapshot naming this provider, without going through the database. */
function snapshotOf(ref: ProviderRef): CatalogSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    providers: [
      {
        provider: `${ref.namespace}/${ref.name}`,
        version: AZURERM_VERSION,
        schemas: AZURERM_SCHEMAS,
      },
    ],
  };
}

describe("the snapshot artefact (GP-239)", () => {
  test("round-trips a whole provider, byte-deterministically", async () => {
    const ref = uniqueRef();
    try {
      await seedReady(ref);
      const snapshot = await exportSnapshot(repo, [ref]);

      assert.equal(snapshot.format, SNAPSHOT_FORMAT);
      assert.equal(snapshot.providers.length, 1);
      const [provider] = snapshot.providers;
      assert.equal(provider?.version, AZURERM_VERSION);
      assert.equal(provider?.schemas.length, AZURERM_SCHEMAS.length);

      const packed = packSnapshot(snapshot);
      assert.deepEqual(unpackSnapshot(packed), snapshot);
      // A release artefact somebody checksums has to be the same bytes twice.
      assert.deepEqual(packSnapshot(snapshot), packed);
      // And worth shipping compressed at all.
      assert.ok(packed.length < JSON.stringify(snapshot).length / 4);
    } finally {
      await cleanup(ref);
    }
  });

  test("a snapshot of the wrong format is refused rather than half-read", () => {
    const bytes = packSnapshot({
      format: SNAPSHOT_FORMAT + 1,
      providers: [],
    });
    assert.throws(() => unpackSnapshot(bytes), /format/);
  });

  test("a provider with nothing ready is left out, not exported empty", async () => {
    const ref = uniqueRef();
    try {
      await repo.ensureProvider(ref, { allowlisted: true });
      const snapshot = await exportSnapshot(repo, [ref]);
      assert.deepEqual(snapshot.providers, []);
    } finally {
      await cleanup(ref);
    }
  });
});

describe("importing a snapshot (GP-239)", () => {
  test("fills an empty catalog, and the result is fully readable", async () => {
    const ref = uniqueRef();
    try {
      const outcomes = await importSnapshot(snapshotOf(ref), {
        repo,
        allowlist: [ref],
      });
      assert.equal(outcomes[0]?.action, "imported");

      const ready = await repo.getLatestReadyVersion(ref);
      assert.equal(ready?.version, AZURERM_VERSION);
      const types = await repo.listResourceTypes(ready!.versionId, { limit: 500 });
      assert.ok(types.items.some((t) => t.type === "azurerm_kubernetes_cluster"));
      const schema = await repo.getResourceSchema(
        ready!.versionId,
        "azurerm_subnet",
      );
      assert.ok(schema);
    } finally {
      await cleanup(ref);
    }
  });

  test("never drags a running instance back to the version it shipped with", async () => {
    const ref = uniqueRef();
    try {
      const provider = await repo.ensureProvider(ref, { allowlisted: true });
      const newer = await repo.ensureVersion(provider.id, "4.99.0");
      await repo.claimExtraction(newer.id, new Date());
      await repo.saveSchemas(newer.id, AZURERM_SCHEMAS.slice(0, 2), new Date());

      const outcomes = await importSnapshot(snapshotOf(ref), {
        repo,
        allowlist: [ref],
      });
      assert.equal(outcomes[0]?.action, "already_ready");
      assert.equal((await repo.getLatestReadyVersion(ref))?.version, "4.99.0");
    } finally {
      await cleanup(ref);
    }
  });

  test("a provider outside the allowlist is not imported", async () => {
    const ref = uniqueRef();
    try {
      const outcomes = await importSnapshot(snapshotOf(ref), {
        repo,
        allowlist: [],
      });
      assert.equal(outcomes[0]?.action, "not_allowlisted");
      assert.equal(await repo.getLatestReadyVersion(ref), null);
    } finally {
      await cleanup(ref);
    }
  });
});

describe("first-boot seeding (GP-239)", () => {
  test("seeds from a bundled file, once", async () => {
    const ref = uniqueRef();
    const dir = await mkdtemp(join(tmpdir(), "catalog-snapshot-"));
    const path = join(dir, "catalog-snapshot.json.gz");
    try {
      await writeFile(path, packSnapshot(snapshotOf(ref)));

      const first = await seedFromSnapshot({ path, repo, allowlist: [ref] });
      assert.equal(first[0]?.action, "imported");
      assert.equal(
        (await repo.getLatestReadyVersion(ref))?.version,
        AZURERM_VERSION,
      );

      // The second boot has nothing to import: the provider is already served,
      // and a snapshot never rolls a running instance back.
      const second = await seedFromSnapshot({ path, repo, allowlist: [ref] });
      assert.deepEqual(
        second.map((o) => o.action),
        ["already_ready"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await cleanup(ref);
    }
  });

  test("no snapshot bundled is not an error — it is a checkout", async () => {
    const ref = uniqueRef();
    assert.deepEqual(
      await seedFromSnapshot({
        path: join(tmpdir(), "definitely-not-here.json.gz"),
        repo,
        allowlist: [ref],
      }),
      [],
    );
  });

  test("an unreadable snapshot is a warning, never a failed boot", async () => {
    const ref = uniqueRef();
    const dir = await mkdtemp(join(tmpdir(), "catalog-snapshot-"));
    const path = join(dir, "broken.json.gz");
    const warnings: unknown[] = [];
    try {
      await writeFile(path, Buffer.from("not a gzip at all"));
      const outcomes = await seedFromSnapshot({
        path,
        repo,
        allowlist: [ref],
        log: { info: () => {}, warn: (obj) => warnings.push(obj) },
      });
      assert.deepEqual(outcomes, []);
      assert.equal(warnings.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await cleanup(ref);
    }
  });
});

describe("air-gapped (GP-239)", () => {
  test("a fresh install with the refresh disabled and no network serves the whole catalog", async () => {
    const ref = uniqueRef();
    const dir = await mkdtemp(join(tmpdir(), "catalog-snapshot-"));
    const path = join(dir, "catalog-snapshot.json.gz");
    try {
      await writeFile(path, packSnapshot(snapshotOf(ref)));

      // A registry that fails the test if it is so much as consulted, and an
      // extractor that does the same: `disabled` means *no outbound call*, and
      // the only honest way to check that is to make one impossible.
      let reached = 0;
      const app = await buildApp(
        {
          ...env,
          builderEnabled: true,
          catalogProviders: `${ref.namespace}/azurerm`,
          catalogRefresh: "disabled",
          catalogSnapshotPath: path,
        },
        {
          catalogRegistry: {
            listVersions: async () => {
              reached += 1;
              throw new Error("an air-gapped instance must not call the registry");
            },
          },
          catalogExtractor: {
            extract: async () => {
              reached += 1;
              throw new Error("an air-gapped instance must not extract");
            },
          },
        },
      );

      try {
        const providers = await app.inject({ url: "/api/v1/catalog/providers" });
        assert.equal(providers.statusCode, 200);
        const body = providers.json();
        assert.equal(body.refresh, "disabled");
        assert.equal(body.providers[0].status, "ready");
        assert.equal(body.providers[0].version, AZURERM_VERSION);

        // The full bundled resource set, not a curated subset.
        const list = await app.inject({
          url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources?limit=500`,
        });
        assert.equal(list.statusCode, 200);
        const resources = list.json().resources as { type: string }[];
        assert.equal(
          resources.length,
          AZURERM_SCHEMAS.filter((s) => s.kind === "resource").length,
        );
        assert.ok(resources.some((r) => r.type === "azurerm_kubernetes_cluster"));

        // And a composition using one of them generates, offline.
        const generated = await app.inject({
          method: "POST",
          url: "/api/v1/builder/generate",
          payload: {
            graph: {
              nodes: [
                {
                  id: "n1",
                  type: "azurerm_kubernetes_cluster",
                  name: "platform",
                  attributes: {
                    name: "aks",
                    location: "westeurope",
                    "default_node_pool.name": "system",
                  },
                },
                {
                  id: "n2",
                  type: "azurerm_resource_group",
                  name: "platform",
                  attributes: { name: "rg", location: "westeurope" },
                },
              ],
              references: [
                { from: "n1", to: "n2", attribute: "resource_group_name" },
              ],
            },
          },
        });
        assert.equal(
          generated.statusCode,
          200,
          `builder must work air-gapped: ${generated.body}`,
        );

        // A refresh tick, explicitly driven, still reaches nothing.
        const outcomes = await app.refreshCatalogOnce();
        assert.ok(outcomes.every((o) => o.action === "skipped_disabled"));
        assert.equal(reached, 0, "no outbound call may be attempted");
      } finally {
        await app.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await cleanup(ref);
    }
  });
});

describe("the allowlist parser is the snapshot's too (GP-239)", () => {
  test("what a deployment configures is what a snapshot may seed", () => {
    // The seeding path and the extraction path read the same list, so a
    // snapshot can never introduce a provider the deployment refused.
    assert.deepEqual(
      parseAllowlist("hashicorp/azurerm").map((r) => `${r.namespace}/${r.name}`),
      ["hashicorp/azurerm"],
    );
  });
});
