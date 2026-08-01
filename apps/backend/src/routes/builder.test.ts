/**
 * The visual builder's endpoints (GP-134): a flag, a generator and a refusal.
 * Everything here runs on a poisoned pool — generation stores nothing, so any
 * database access at all would be a bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { parse } from "@groundplan/graph-parser";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { authHeader, testAuthEnv, testKeyResolver } from "../test-support.js";

const env = loadEnv();
const builderEnv = { ...env, builderEnabled: true };

/** A pool whose every query rejects — proves a route never touches the DB. */
function poisonedPool(): Pool {
  return {
    query: async () => {
      throw new Error("the builder must not touch the database");
    },
    end: async () => {},
  } as unknown as Pool;
}

/** The demo topology of GP-131, as the canvas would send it. */
function demoGraph() {
  return {
    nodes: [
      {
        id: "n1",
        type: "azurerm_resource_group",
        name: "this",
        attributes: { name: "rg-demo", location: "westeurope" },
        position: { x: 0, y: 0 },
      },
      {
        id: "n2",
        type: "azurerm_virtual_network",
        name: "this",
        attributes: {
          name: "vnet-demo",
          location: "westeurope",
          address_space: ["10.0.0.0/16"],
        },
        position: { x: 0, y: 160 },
      },
      {
        id: "n3",
        type: "azurerm_subnet",
        name: "app",
        attributes: { name: "snet-app", address_prefixes: ["10.0.1.0/24"] },
        position: { x: 0, y: 320 },
      },
    ],
    references: [
      { from: "n2", to: "n1", attribute: "resource_group_name" },
      { from: "n3", to: "n1", attribute: "resource_group_name" },
      { from: "n3", to: "n2", attribute: "virtual_network_name" },
    ],
  };
}

test("GET /builder/status: disabled by default", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/builder/status" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { enabled: false });
  } finally {
    await app.close();
  }
});

test("GET /builder/status: enabled by BUILDER_ENABLED", async () => {
  const app = await buildApp(builderEnv, { pool: poisonedPool() });
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/builder/status" });
    assert.deepEqual(res.json(), { enabled: true });
  } finally {
    await app.close();
  }
});

test("POST /builder/generate: 404 while the flag is off", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: { graph: demoGraph() },
    });
    // Not a 403: a feature that is off is a feature that does not exist.
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /builder/generate: a composed graph becomes Terraform files", async () => {
  const app = await buildApp(builderEnv, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: { graph: demoGraph() },
    });
    assert.equal(res.statusCode, 200);
    const { files } = res.json() as { files: { path: string; content: string }[] };
    assert.deepEqual(
      files.map((f) => f.path),
      ["main.tf", "network.tf"],
    );

    // The golden invariant, on the wire: what came back parses into the graph
    // that was composed.
    const { snapshot } = parse(files);
    assert.deepEqual(
      snapshot.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)),
      [
        "azurerm_resource_group.this",
        "azurerm_subnet.app",
        "azurerm_virtual_network.this",
      ],
    );
    assert.equal(
      snapshot.edges.filter((e) => e.kind === "depends_on").length,
      3,
    );
  } finally {
    await app.close();
  }
});

test("POST /builder/generate: byte-identical across calls", async () => {
  const app = await buildApp(builderEnv, { pool: poisonedPool() });
  try {
    const call = async () =>
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/builder/generate",
          payload: { graph: demoGraph() },
        })
      ).body;
    assert.equal(await call(), await call());
  } finally {
    await app.close();
  }
});

test("POST /builder/generate: 422 naming every offending node", async () => {
  const app = await buildApp(builderEnv, { pool: poisonedPool() });
  try {
    const graph = demoGraph();
    // Two mistakes, in two different nodes: an empty required field and a
    // connection nobody made.
    graph.nodes[0]!.attributes.name = "";
    graph.references = graph.references.filter(
      (r) => r.attribute !== "virtual_network_name",
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: { graph },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json() as {
      fields: { field: string; message: string; nodeId: string; reason: string }[];
    };
    assert.deepEqual(
      body.fields.map((f) => f.field),
      [
        "azurerm_resource_group.this.name",
        "azurerm_subnet.app.virtual_network_name",
      ],
    );
    // The node id rides along so the canvas can badge without parsing prose.
    assert.deepEqual(
      body.fields.map((f) => f.nodeId),
      ["n1", "n3"],
    );
  } finally {
    await app.close();
  }
});

test("POST /builder/generate: an unknown resource type is refused, not skipped", async () => {
  const app = await buildApp(builderEnv, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: {
        graph: {
          nodes: [
            { id: "x", type: "aws_instance", name: "web", attributes: {} },
          ],
        },
      },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(
      (res.json() as { fields: { reason: string }[] }).fields[0]?.reason,
      "unknown_type",
    );
  } finally {
    await app.close();
  }
});

test("POST /builder/generate: a malformed body is a schema 422, not a stack trace", async () => {
  const app = await buildApp(builderEnv, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: { graph: { nodes: [] } },
    });
    // The app-wide mapping for a schema failure (plugins/error-handler).
    assert.equal(res.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("the builder routes sit behind the global auth hook", async () => {
  // The auth-configured env, with the flag on: the hook is what is under test,
  // not the flag.
  // A real pool here, unlike every test above: the auth hook upserts the user
  // it just authenticated, so this one does touch the database.
  const app = await buildApp(
    { ...testAuthEnv(), builderEnabled: true },
    { jwks: await testKeyResolver() },
  );
  try {
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: { graph: demoGraph() },
    });
    assert.equal(anonymous.statusCode, 401);

    const authenticated = await app.inject({
      method: "POST",
      url: "/api/v1/builder/generate",
      payload: { graph: demoGraph() },
      headers: await authHeader(),
    });
    assert.equal(authenticated.statusCode, 200);
  } finally {
    await app.close();
  }
});
