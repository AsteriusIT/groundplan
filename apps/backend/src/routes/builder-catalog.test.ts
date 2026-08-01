/**
 * Generating from a type nobody curated (GP-238).
 *
 * `builder.test.ts` covers the curated dozen, on a poisoned pool — which is now
 * also the proof that a composition of curated resources costs no query. This
 * file covers the other half: a type read from the provider is validated
 * against the provider's own schema, generated into the provider's file, and
 * refused outright while the catalog has not been read.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import { parse } from "@groundplan/graph-parser";

import { buildApp } from "../app.js";
import { AZURERM_SCHEMAS } from "../catalog/__fixtures__/azurerm.js";
import { catalogRepository } from "../catalog/repository.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { catalogProviders } from "../db/schema.js";

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const db = drizzle(pool);
const repo = catalogRepository(db);

before(async () => {
  await runMigrations(env.databaseUrl);
});

function uniqueRef() {
  return {
    namespace: `test-${Date.now()}-${randomBytes(4).toString("hex")}`,
    name: "azurerm",
  };
}

async function cleanup(namespace: string): Promise<void> {
  await db
    .delete(catalogProviders)
    .where(eq(catalogProviders.namespace, namespace));
}

async function seedReady(ref: { namespace: string; name: string }) {
  const provider = await repo.ensureProvider(ref, { allowlisted: true });
  const version = await repo.ensureVersion(provider.id, "4.81.0");
  await repo.claimExtraction(version.id, new Date());
  await repo.saveSchemas(version.id, AZURERM_SCHEMAS, new Date());
}

function appFor(namespace: string) {
  return buildApp({
    ...env,
    builderEnabled: true,
    catalogProviders: `${namespace}/azurerm`,
  });
}

/** A resource group plus a cluster nobody curated, connected to it. */
const GRAPH = {
  nodes: [
    {
      id: "n1",
      type: "azurerm_resource_group",
      name: "platform",
      attributes: { name: "rg-platform", location: "westeurope" },
    },
    {
      id: "n2",
      type: "azurerm_kubernetes_cluster",
      name: "platform",
      attributes: {
        name: "aks-platform",
        location: "westeurope",
        dns_prefix: "platform",
        "default_node_pool.name": "system",
      },
    },
  ],
  references: [
    { from: "n2", to: "n1", attribute: "resource_group_name" },
  ],
};

describe("POST /builder/generate against the catalog (GP-238)", () => {
  test("generates a type read from the provider, into the provider's file", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/builder/generate",
        payload: { graph: GRAPH },
      });
      assert.equal(res.statusCode, 200, res.body);

      const files = res.json().files as { path: string; content: string }[];
      assert.deepEqual(files.map((f) => f.path).sort(), ["azurerm.tf", "main.tf"]);

      const main = files.find((f) => f.path === "main.tf")!.content;
      // The provider version the composition was checked against is the one the
      // generated file pins.
      assert.match(main, /version = "~> 4\.0"/);

      const azurerm = files.find((f) => f.path === "azurerm.tf")!.content;
      assert.match(azurerm, /resource "azurerm_kubernetes_cluster" "platform"/);
      assert.match(azurerm, /default_node_pool \{[\s\S]*name\s+= "system"/);

      // The golden invariant (GP-134), still holding for a derived type: what
      // was generated, parsed back by Producer B, is the graph that was drawn.
      const { snapshot } = parse(files);
      const ids = snapshot.nodes
        .map((n) => n.id)
        .sort((a, b) => a.localeCompare(b));
      assert.deepEqual(ids, [
        "azurerm_kubernetes_cluster.platform",
        "azurerm_resource_group.platform",
      ]);
      assert.ok(
        snapshot.edges.some(
          (e) =>
            e.from === "azurerm_kubernetes_cluster.platform" &&
            e.to === "azurerm_resource_group.platform",
        ),
        "the connection must come back as a reference edge",
      );
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("refuses an attribute the provider does not have", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/builder/generate",
        payload: {
          graph: {
            ...GRAPH,
            nodes: GRAPH.nodes.map((node) =>
              node.id === "n2"
                ? {
                    ...node,
                    attributes: { ...node.attributes, not_a_thing: "x" },
                  }
                : node,
            ),
          },
        },
      });
      assert.equal(res.statusCode, 422);
      const fields = res.json().fields as { field: string; reason: string }[];
      assert.ok(
        fields.some(
          (f) =>
            f.reason === "unknown_attribute" &&
            f.field.endsWith(".not_a_thing"),
        ),
        JSON.stringify(fields),
      );
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("refuses to judge a composition while the catalog is still warming", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/builder/generate",
        payload: { graph: GRAPH },
      });
      // Not a 422 and not a 200: a graph checked against a catalog we do not
      // have is a graph checked against nothing, and "looks fine" would be the
      // one dishonest answer available here.
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, "catalog_warming");
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("a composition of curated resources still generates while warming", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/builder/generate",
        payload: { graph: { nodes: [GRAPH.nodes[0]], references: [] } },
      });
      // The twelve are compiled in. A deployment that never ran the catalog
      // worker has a builder, and this is that promise as a test.
      assert.equal(res.statusCode, 200, res.body);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });
});
