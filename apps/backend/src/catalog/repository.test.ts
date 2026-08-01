/**
 * The catalog store (GP-234), against a real Postgres — the compression round
 * trip, the status transitions, single-flight and the "no ready version yet"
 * path a warming instance lives in.
 *
 * The schemas are the provider's own: a verbatim subset of
 * `terraform providers schema -json` for azurerm 4.81.0, including
 * `azurerm_kubernetes_cluster`, which is the largest thing the catalog will ever
 * be asked to store. A hand-written fixture would prove the code round-trips a
 * hand-written fixture.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import {
  parseProviderSchema,
  type RawProvidersSchema,
} from "@groundplan/builder";

import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { catalogProviders, catalogProviderVersions } from "../db/schema.js";
import { packSchema, unpackSchema } from "./compress.js";
import { catalogRepository, EXTRACTION_LEASE_MS } from "./repository.js";
import type { ProviderRef } from "./providers.js";

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const db = drizzle(pool);
const repo = catalogRepository(db);

const RAW = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/azurerm-4.81.0-subset.json", import.meta.url),
    "utf8",
  ),
) as RawProvidersSchema;

const SCHEMAS = parseProviderSchema(RAW, {
  provider: "hashicorp/azurerm",
  version: "4.81.0",
});

before(async () => {
  await runMigrations(env.databaseUrl);
});

/**
 * A provider nobody else in the suite uses. The catalog tables are global (no
 * organization to scope a test to), so isolation comes from a unique namespace,
 * and the rows are removed at the end of each test.
 */
function uniqueProvider(): ProviderRef {
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

/** A provider with one version, claimed and ready to be written into. */
async function seedClaimedVersion(ref: ProviderRef, version = "4.81.0") {
  const provider = await repo.ensureProvider(ref, { allowlisted: true });
  const created = await repo.ensureVersion(provider.id, version);
  const claimed = await repo.claimExtraction(created.id, new Date());
  assert.ok(claimed, "expected to win the claim on a fresh version");
  return { provider, versionId: created.id };
}

describe("compression (GP-234)", () => {
  test("a real azurerm schema survives the round trip unchanged", () => {
    const cluster = SCHEMAS.find(
      (s) => s.type === "azurerm_kubernetes_cluster",
    );
    assert.ok(cluster, "fixture must carry the largest azurerm resource");
    const packed = packSchema(cluster);
    assert.deepEqual(unpackSchema(packed.bytes), cluster);
    // It is worth compressing at all: this is the reason for a bytea column.
    assert.ok(packed.rawBytes > 20_000);
    assert.ok(packed.bytes.length < packed.rawBytes / 4);
  });

  test("packing is deterministic — the same schema is the same bytes", () => {
    const [first] = SCHEMAS;
    assert.ok(first);
    assert.deepEqual(packSchema(first).bytes, packSchema(first).bytes);
  });
});

describe("catalogRepository (GP-234)", () => {
  test("stores and reads back every schema of a version", async () => {
    const ref = uniqueProvider();
    try {
      const { versionId } = await seedClaimedVersion(ref);
      const stored = await repo.saveSchemas(versionId, SCHEMAS, new Date());
      assert.equal(stored, SCHEMAS.length);

      const ready = await repo.getLatestReadyVersion(ref);
      assert.ok(ready);
      assert.equal(ready.version, "4.81.0");
      assert.ok(ready.extractedAt instanceof Date);

      const page = await repo.listResourceTypes(ready.versionId, { limit: 500 });
      const resources = SCHEMAS.filter((s) => s.kind === "resource");
      assert.equal(page.total, resources.length);
      assert.deepEqual(
        page.items.map((i) => i.type),
        resources.map((s) => s.type).sort((a, b) => a.localeCompare(b)),
      );

      // A summary and an argument count, but never a schema blob in a list.
      const subnet = page.items.find((i) => i.type === "azurerm_subnet");
      assert.ok(subnet);
      assert.ok(subnet.attributeCount > 5);
      assert.equal("schema" in subnet, false);

      const schema = await repo.getResourceSchema(
        ready.versionId,
        "azurerm_subnet",
      );
      assert.ok(schema);
      assert.equal(schema.provider, "hashicorp/azurerm");
      assert.equal(schema.version, "4.81.0");
      assert.deepEqual(
        schema,
        SCHEMAS.find((s) => s.type === "azurerm_subnet" && s.kind === "resource"),
      );
    } finally {
      await cleanup(ref);
    }
  });

  test("lists data sources only when asked — a data source cannot be composed", async () => {
    const ref = uniqueProvider();
    try {
      const { versionId } = await seedClaimedVersion(ref);
      await repo.saveSchemas(versionId, SCHEMAS, new Date());

      const resources = await repo.listResourceTypes(versionId, { limit: 500 });
      assert.ok(resources.items.every((i) => i.kind === "resource"));

      const all = await repo.listResourceTypes(versionId, {
        kind: "all",
        limit: 500,
      });
      assert.equal(all.total, SCHEMAS.length);
    } finally {
      await cleanup(ref);
    }
  });

  test("filters and pages the resource list stably", async () => {
    const ref = uniqueProvider();
    try {
      const { versionId } = await seedClaimedVersion(ref);
      await repo.saveSchemas(versionId, SCHEMAS, new Date());

      const filtered = await repo.listResourceTypes(versionId, {
        query: "network",
      });
      assert.ok(filtered.total >= 2);
      assert.ok(filtered.items.every((i) => i.type.includes("network")));

      const first = await repo.listResourceTypes(versionId, { limit: 2 });
      const second = await repo.listResourceTypes(versionId, {
        limit: 2,
        offset: 2,
      });
      assert.equal(first.items.length, 2);
      // Paging must not repeat a row: the order is by name, not by insertion.
      assert.equal(
        new Set([...first.items, ...second.items].map((i) => i.type)).size,
        first.items.length + second.items.length,
      );
    } finally {
      await cleanup(ref);
    }
  });

  test("a LIKE metacharacter in the query is the character the user typed", async () => {
    const ref = uniqueProvider();
    try {
      const { versionId } = await seedClaimedVersion(ref);
      await repo.saveSchemas(versionId, SCHEMAS, new Date());

      // `%` matches nothing because no type contains a literal percent sign —
      // if it were passed through it would match every row.
      const percent = await repo.listResourceTypes(versionId, { query: "%" });
      assert.equal(percent.total, 0);
      // `_` is a real character in every Terraform type, and only that.
      const underscore = await repo.listResourceTypes(versionId, {
        query: "key_vault",
      });
      assert.equal(underscore.total, 1);
    } finally {
      await cleanup(ref);
    }
  });

  test("no ready version yet: reads answer null rather than inventing one", async () => {
    const ref = uniqueProvider();
    try {
      assert.equal(await repo.getLatestReadyVersion(ref), null);

      const provider = await repo.ensureProvider(ref, { allowlisted: true });
      const version = await repo.ensureVersion(provider.id, "4.81.0");
      assert.equal(version.status, "pending");
      // Pending and extracting are both invisible to a reader.
      assert.equal(await repo.getLatestReadyVersion(ref), null);
      await repo.claimExtraction(version.id, new Date());
      assert.equal(await repo.getLatestReadyVersion(ref), null);
    } finally {
      await cleanup(ref);
    }
  });

  test("single-flight: exactly one claimer, and the loser gets null", async () => {
    const ref = uniqueProvider();
    try {
      const provider = await repo.ensureProvider(ref, { allowlisted: true });
      const version = await repo.ensureVersion(provider.id, "4.81.0");
      const now = new Date();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => repo.claimExtraction(version.id, now)),
      );
      assert.equal(results.filter(Boolean).length, 1);
    } finally {
      await cleanup(ref);
    }
  });

  test("a claim older than the lease is reclaimable, a fresh one is not", async () => {
    const ref = uniqueProvider();
    try {
      const provider = await repo.ensureProvider(ref, { allowlisted: true });
      const version = await repo.ensureVersion(provider.id, "4.81.0");
      const start = new Date();
      assert.ok(await repo.claimExtraction(version.id, start));

      const soon = new Date(start.getTime() + EXTRACTION_LEASE_MS - 1000);
      assert.equal(await repo.claimExtraction(version.id, soon), null);

      const later = new Date(start.getTime() + EXTRACTION_LEASE_MS + 1000);
      const reclaimed = await repo.claimExtraction(version.id, later);
      assert.ok(reclaimed);
      assert.equal(reclaimed.attempts, 2);
    } finally {
      await cleanup(ref);
    }
  });

  test("a failure keeps the previous ready version being served", async () => {
    const ref = uniqueProvider();
    try {
      const { versionId } = await seedClaimedVersion(ref, "4.81.0");
      await repo.saveSchemas(versionId, SCHEMAS, new Date());

      const provider = await repo.findProvider(ref);
      assert.ok(provider);
      const next = await repo.ensureVersion(provider.id, "4.82.0");
      await repo.claimExtraction(next.id, new Date());
      await repo.failExtraction(next.id, "provider download failed\nstack…", new Date());

      const ready = await repo.getLatestReadyVersion(ref);
      assert.equal(ready?.version, "4.81.0");

      const [row] = await db
        .select()
        .from(catalogProviderVersions)
        .where(eq(catalogProviderVersions.id, next.id));
      assert.equal(row?.status, "failed");
      // One line, not a stack trace: this is read back into a status field.
      assert.equal(row?.error, "provider download failed");

      const states = await repo.listProviders();
      const state = states.find((s) => s.namespace === ref.namespace);
      assert.equal(state?.readyVersion, "4.81.0");
      assert.equal(state?.lastError, "provider download failed");
    } finally {
      await cleanup(ref);
    }
  });

  test("re-extracting a version replaces its types instead of accumulating", async () => {
    const ref = uniqueProvider();
    try {
      const { versionId } = await seedClaimedVersion(ref);
      await repo.saveSchemas(versionId, SCHEMAS, new Date());
      const before = await repo.listResourceTypes(versionId, { limit: 500 });

      await repo.saveSchemas(versionId, SCHEMAS.slice(0, 2), new Date());
      const after = await repo.listResourceTypes(versionId, {
        kind: "all",
        limit: 500,
      });
      assert.equal(after.total, 2);
      assert.ok(before.total > after.total);
      // And a type the provider dropped is really gone, not merely unlisted.
      assert.ok(
        SCHEMAS.slice(0, 2).every((s) => s.type !== "azurerm_subnet"),
        "the second extraction must not carry the type this asserts is gone",
      );
      assert.equal(
        await repo.getResourceSchema(versionId, "azurerm_subnet"),
        null,
      );
    } finally {
      await cleanup(ref);
    }
  });

  test("ensureProvider is idempotent and keeps the allowlist flag current", async () => {
    const ref = uniqueProvider();
    try {
      const first = await repo.ensureProvider(ref, { allowlisted: true });
      const second = await repo.ensureProvider(ref, { allowlisted: false });
      assert.equal(first.id, second.id);
      assert.equal(second.allowlisted, false);
    } finally {
      await cleanup(ref);
    }
  });

  test("ensureVersion never knocks a ready version back to pending", async () => {
    const ref = uniqueProvider();
    try {
      const { provider, versionId } = await seedClaimedVersion(ref);
      await repo.saveSchemas(versionId, SCHEMAS, new Date());

      const again = await repo.ensureVersion(provider.id, "4.81.0");
      assert.equal(again.status, "ready");
      assert.equal(again.id, versionId);
    } finally {
      await cleanup(ref);
    }
  });

  test("recordRegistryCheck dates the check even when no version was named", async () => {
    const ref = uniqueProvider();
    try {
      const provider = await repo.ensureProvider(ref, { allowlisted: true });
      const at = new Date();
      await repo.recordRegistryCheck(provider.id, {
        latestVersion: "4.82.0",
        checkedAt: at,
      });
      let row = await repo.findProvider(ref);
      assert.equal(row?.latestKnownVersion, "4.82.0");

      const later = new Date(at.getTime() + 60_000);
      await repo.recordRegistryCheck(provider.id, {
        latestVersion: null,
        checkedAt: later,
      });
      row = await repo.findProvider(ref);
      // The failed check still counts as a check; what we knew is not forgotten.
      assert.equal(row?.latestKnownVersion, "4.82.0");
      assert.equal(row?.lastCheckedAt?.getTime(), later.getTime());
    } finally {
      await cleanup(ref);
    }
  });
});
