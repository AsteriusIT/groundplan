/**
 * The catalog read API (GP-237).
 *
 * The interesting cases are the refusals and the states: an un-allowlisted
 * provider is indistinguishable from one that does not exist, a warming
 * instance says so instead of answering with an empty list, and a read never
 * carries a schema blob it was not asked for.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import {
  parseProviderSchema,
  type RawProvidersSchema,
} from "@groundplan/builder";

import { buildApp } from "../app.js";
import { catalogRepository } from "../catalog/repository.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { catalogProviders } from "../db/schema.js";
import { authHeader, buildTestApp } from "../test-support.js";

const env = loadEnv();
const pool = new Pool({ connectionString: env.databaseUrl });
const db = drizzle(pool);
const repo = catalogRepository(db);

const SCHEMAS = parseProviderSchema(
  JSON.parse(
    readFileSync(
      new URL("../catalog/__fixtures__/azurerm-4.81.0-subset.json", import.meta.url),
      "utf8",
    ),
  ) as RawProvidersSchema,
  { provider: "hashicorp/azurerm", version: "4.81.0" },
);

before(async () => {
  await runMigrations(env.databaseUrl);
});

/**
 * A provider under a namespace of its own, allowlisted on the app under test.
 * The catalog tables are global, so a unique namespace is what keeps parallel
 * test processes (and a developer's real catalog) out of each other's way.
 */
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

/** An app that allowlists exactly this provider. */
function appFor(namespace: string, name = "azurerm"): Promise<FastifyInstance> {
  return buildApp({ ...env, catalogProviders: `${namespace}/${name}` });
}

/** Seed a ready version so a read has something to answer with. */
async function seedReady(ref: { namespace: string; name: string }) {
  const provider = await repo.ensureProvider(ref, { allowlisted: true });
  const version = await repo.ensureVersion(provider.id, "4.81.0");
  await repo.claimExtraction(version.id, new Date());
  await repo.saveSchemas(version.id, SCHEMAS, new Date());
}

describe("GET /catalog/providers (GP-237)", () => {
  test("lists the allowlist, and dates what is being served", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const res = await app.inject({ url: "/api/v1/catalog/providers" });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      assert.equal(body.refresh, env.catalogRefresh);
      assert.equal(body.providers.length, 1);
      const [provider] = body.providers;
      assert.equal(provider.provider, `${ref.namespace}/azurerm`);
      assert.equal(provider.version, "4.81.0");
      assert.equal(provider.status, "ready");
      // Every surface dates both sides: a catalog with no read date is a
      // catalog nobody can tell is stale.
      assert.ok(Date.parse(provider.readAt) > 0);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("a configured provider nobody has extracted yet is listed as warming", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      const res = await app.inject({ url: "/api/v1/catalog/providers" });
      const [provider] = res.json().providers;
      // A fresh install must not look like an instance that supports nothing.
      assert.equal(provider.status, "warming");
      assert.equal(provider.version, null);
    } finally {
      await app.close();
    }
  });

  test("a provider that fell out of the allowlist is reported as retired", async () => {
    const ref = uniqueRef();
    const other = uniqueRef();
    const app = await appFor(other.namespace);
    try {
      await seedReady(ref);
      const body = (await app.inject({ url: "/api/v1/catalog/providers" })).json();
      assert.deepEqual(
        body.providers.map((p: { provider: string }) => p.provider),
        [`${other.namespace}/azurerm`],
      );
      assert.ok(body.retired.includes(`${ref.namespace}/azurerm`));
    } finally {
      await app.close();
      await cleanup(ref.namespace);
      await cleanup(other.namespace);
    }
  });

  test("requires a session, like everything else under /api/v1", async () => {
    const app = await buildTestApp();
    try {
      assert.equal(
        (await app.inject({ url: "/api/v1/catalog/providers" })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/v1/catalog/providers",
            headers: await authHeader(),
          })
        ).statusCode,
        200,
      );
    } finally {
      await app.close();
    }
  });
});

describe("GET /catalog/.../resources (GP-237)", () => {
  test("lists every resource type, without a schema in sight", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const res = await app.inject({
        url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources?limit=500`,
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      assert.equal(body.version, "4.81.0");
      assert.equal(body.total, SCHEMAS.filter((s) => s.kind === "resource").length);
      assert.ok(body.resources.some((r: { type: string }) => r.type === "azurerm_subnet"));
      // The payload budget: names, kinds, summaries, counts. Nothing else.
      assert.deepEqual(
        Object.keys(body.resources[0]).sort(),
        ["attributeCount", "kind", "summary", "type"],
      );
      assert.equal(JSON.stringify(body).includes('"attributes"'), false);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("filters and pages server-side", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const filtered = (
        await app.inject({
          url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources?q=network`,
        })
      ).json();
      assert.ok(filtered.total >= 2);
      assert.ok(
        filtered.resources.every((r: { type: string }) => r.type.includes("network")),
      );

      const paged = (
        await app.inject({
          url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources?limit=2&offset=1`,
        })
      ).json();
      assert.equal(paged.resources.length, 2);
      assert.equal(paged.offset, 1);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("an unknown or un-allowlisted provider is a 404 either way", async () => {
    const ref = uniqueRef();
    const stranger = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      // One exists in the table but is not allowlisted here; the other does not
      // exist at all. The two answers must be indistinguishable — the allowlist
      // is a security boundary, not a directory to enumerate.
      await seedReady(stranger);
      const listed = await app.inject({
        url: `/api/v1/catalog/providers/${stranger.namespace}/azurerm/resources`,
      });
      const absent = await app.inject({
        url: "/api/v1/catalog/providers/nobody/nothing/resources",
      });
      assert.equal(listed.statusCode, 404);
      assert.equal(absent.statusCode, 404);
      assert.equal(listed.json().error, absent.json().error);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
      await cleanup(stranger.namespace);
    }
  });

  test("a warming catalog says so rather than answering with nothing", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      const res = await app.inject({
        url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources`,
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, "catalog_warming");
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("revalidates with an ETag: the same catalog answers 304", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const url = `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources?q=subnet`;
      const first = await app.inject({ url });
      const etag = first.headers.etag as string;
      assert.ok(etag);
      assert.match(first.headers["cache-control"] as string, /must-revalidate/);

      const again = await app.inject({ url, headers: { "if-none-match": etag } });
      assert.equal(again.statusCode, 304);
      assert.equal(again.body, "");

      // A different query is a different answer, so the ETag must differ.
      const other = await app.inject({
        url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources?q=key`,
        headers: { "if-none-match": etag },
      });
      assert.equal(other.statusCode, 200);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("a read never triggers an extraction", async () => {
    const ref = uniqueRef();
    let extracted = 0;
    const app = await buildApp(
      { ...env, catalogProviders: `${ref.namespace}/azurerm` },
      {
        catalogExtractor: {
          extract: async () => {
            extracted += 1;
            return SCHEMAS;
          },
        },
        catalogRegistry: { listVersions: async () => ["4.81.0"] },
      },
    );
    try {
      // Warming, and it stays warming: a read that could start a ten-minute
      // `terraform init` is a read that will one day time out in a browser.
      const res = await app.inject({
        url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources`,
      });
      assert.equal(res.statusCode, 503);
      assert.equal(extracted, 0);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });
});

describe("GET /catalog/.../resources/:type (GP-237)", () => {
  test("answers one type's schema, with the provider's own flags", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const res = await app.inject({
        url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources/azurerm_subnet`,
      });
      assert.equal(res.statusCode, 200);
      const { schema, version } = res.json();
      assert.equal(version, "4.81.0");
      assert.equal(schema.type, "azurerm_subnet");

      const name = schema.attributes.find((a: { name: string }) => a.name === "name");
      assert.equal(name.required, true);
      assert.equal(name.kind, "string");
      const id = schema.attributes.find((a: { name: string }) => a.name === "id");
      assert.equal(id.computed, true);
      assert.ok(schema.blocks.some((b: { name: string }) => b.name === "delegation"));
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("a type the version does not carry is a 404", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const res = await app.inject({
        url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources/azurerm_not_a_thing`,
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("a data source is reachable, but only when asked for by kind", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const base = `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources/azurerm_client_config`;
      assert.equal((await app.inject({ url: base })).statusCode, 404);
      assert.equal(
        (await app.inject({ url: `${base}?kind=data_source` })).statusCode,
        200,
      );
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });

  test("revalidates per type", async () => {
    const ref = uniqueRef();
    const app = await appFor(ref.namespace);
    try {
      await seedReady(ref);
      const url = `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources/azurerm_subnet`;
      const first = await app.inject({ url });
      const etag = first.headers.etag as string;
      assert.equal(
        (await app.inject({ url, headers: { "if-none-match": etag } })).statusCode,
        304,
      );
      // Another type of the same version is another answer.
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/catalog/providers/${ref.namespace}/azurerm/resources/azurerm_key_vault`,
            headers: { "if-none-match": etag },
          })
        ).statusCode,
        200,
      );
    } finally {
      await app.close();
      await cleanup(ref.namespace);
    }
  });
});
