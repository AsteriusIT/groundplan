/**
 * Playground parse endpoint (GP-123): ephemeral HCL → GraphSnapshot, nothing
 * persisted. Functional tests run in open mode (`buildApp`); the auth check
 * runs against `buildTestApp` because the route sits behind the global hook.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { authHeader, buildTestApp } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** Two files with a cross-file reference — the minimal "real" playground. */
const CROSS_FILE_HCL = [
  {
    path: "main.tf",
    content: [
      `resource "azurerm_resource_group" "rg" {`,
      `  name     = "playground"`,
      `  location = "westeurope"`,
      `}`,
    ].join("\n"),
  },
  {
    path: "network.tf",
    content: [
      `resource "azurerm_virtual_network" "vnet" {`,
      `  name                = "vnet"`,
      `  resource_group_name = azurerm_resource_group.rg.name`,
      `  location            = azurerm_resource_group.rg.location`,
      `}`,
    ].join("\n"),
  },
];

/** A pool whose every query rejects — proves a route never touches the DB. */
function poisonedPool(): Pool {
  return {
    query: async () => {
      throw new Error("playground must not touch the database");
    },
    end: async () => {},
  } as unknown as Pool;
}

test("POST /playground/parse: cross-file HCL → snapshot with implicit deps", async () => {
  // Built on a poisoned pool: any DB access (persistence included) would 500.
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    const ids = body.graph.nodes.map((n: { id: string }) => n.id).sort();
    assert.deepEqual(ids, [
      "azurerm_resource_group.rg",
      "azurerm_virtual_network.vnet",
    ]);
    // The cross-file reference becomes an inferred depends_on edge (GP-21).
    const edge = body.graph.edges.find(
      (e: { from: string; to: string }) =>
        e.from === "azurerm_virtual_network.vnet" &&
        e.to === "azurerm_resource_group.rg",
    );
    assert.ok(edge, "expected an inferred cross-file edge");
    assert.equal(edge.kind, "depends_on");
    assert.equal(edge.inferred, true);

    // Docs-shaped snapshot: no change data, stats + summary present.
    for (const node of body.graph.nodes) assert.equal(node.change, null);
    assert.equal(body.stats.nodes, 2);
    assert.equal(body.stats.edges, 1);
    assert.equal(typeof body.summaryMd, "string");
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: identical calls return identical snapshots", async () => {
  const app = await buildApp(env);
  try {
    const once = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL },
    });
    const twice = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL },
    });
    assert.equal(once.statusCode, 200);
    assert.deepEqual(once.json(), twice.json());
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: invalid HCL → 422 naming the offending file", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: {
        files: [
          { path: "ok.tf", content: `resource "null_resource" "a" {}` },
          { path: "broken.tf", content: `resource "null_resource" "b" {` },
        ],
      },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.error, "Unprocessable Entity");
    const field = body.fields.find(
      (f: { field: string }) => f.field === "broken.tf",
    );
    assert.ok(field, "expected the broken file to be named");
    assert.ok(field.message.length > 0);
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: .tfvars accepted, other extensions 422", async () => {
  const app = await buildApp(env);
  try {
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: {
        files: [
          { path: "main.tf", content: `resource "null_resource" "a" {}` },
          { path: "env.tfvars", content: `region = "westeurope"` },
        ],
      },
    });
    assert.equal(ok.statusCode, 200);

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: [{ path: "script.sh", content: "echo hi" }] },
    });
    assert.equal(bad.statusCode, 422);
    const field = bad.json().fields.find(
      (f: { field: string }) => f.field === "script.sh",
    );
    assert.ok(field, "expected the disallowed file to be named");
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: duplicate paths → 422", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: {
        files: [
          { path: "main.tf", content: `resource "null_resource" "a" {}` },
          { path: "main.tf", content: `resource "null_resource" "b" {}` },
        ],
      },
    });
    assert.equal(res.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: over the file-count limit → explicit 400", async () => {
  const app = await buildApp(env);
  try {
    const files = Array.from({ length: 51 }, (_, i) => ({
      path: `f${i}.tf`,
      content: `resource "null_resource" "r${i}" {}`,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /50/);
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: over the total-size limit → explicit 413", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: {
        files: [{ path: "big.tf", content: "#".repeat(1024 * 1024 + 1) }],
      },
    });
    assert.equal(res.statusCode, 413);
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: requires a bearer token when auth is on", async () => {
  const app = await buildTestApp();
  try {
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL },
    });
    assert.equal(anonymous.statusCode, 401);

    const authed = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL },
      headers: await authHeader(),
    });
    assert.equal(authed.statusCode, 200);
  } finally {
    await app.close();
  }
});
