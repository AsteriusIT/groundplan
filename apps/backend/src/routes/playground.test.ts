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

// ---------------------------------------------------------------------------
// Drafts (GP-124): user-scoped CRUD over the HCL source files, never snapshots.
// Auth is ON for all of these — ownership is the whole point.
// ---------------------------------------------------------------------------

/** JIT-provision a user by making one authed call; return their id. */
async function provision(
  app: Awaited<ReturnType<typeof buildTestApp>>,
  sub: string,
) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: await authHeader({ sub }),
  });
  return res.json().id as string;
}

const DRAFT_FILES = [
  { path: "main.tf", content: `resource "null_resource" "a" {}` },
  { path: "vars.tfvars", content: `region = "westeurope"` },
];

test("drafts: create → list → get → update → delete, scoped to the author", async () => {
  const app = await buildTestApp();
  const sub = `pg-owner-${Date.now()}`;
  try {
    await provision(app, sub);
    const headers = await authHeader({ sub });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: { name: "my sketch", files: DRAFT_FILES },
      headers,
    });
    assert.equal(created.statusCode, 201);
    const draft = created.json();
    assert.equal(draft.name, "my sketch");
    assert.deepEqual(draft.files, DRAFT_FILES);

    // The list carries id, name, updatedAt and a file count — no content.
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/playground/drafts",
      headers,
    });
    assert.equal(listed.statusCode, 200);
    const entry = listed
      .json()
      .find((d: { id: string }) => d.id === draft.id);
    assert.ok(entry, "created draft appears in the list");
    assert.equal(entry.fileCount, 2);
    assert.equal(entry.files, undefined);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/playground/drafts/${draft.id}`,
      headers,
    });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json().files, DRAFT_FILES);

    // Update replaces the whole file set (no per-file patch).
    const newFiles = [{ path: "other.tf", content: `# rewritten` }];
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/playground/drafts/${draft.id}`,
      payload: { name: "renamed", files: newFiles },
      headers,
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().name, "renamed");
    assert.deepEqual(updated.json().files, newFiles);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/playground/drafts/${draft.id}`,
      headers,
    });
    assert.equal(deleted.statusCode, 204);
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/playground/drafts/${draft.id}`,
      headers,
    });
    assert.equal(gone.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("drafts: another user's draft is a 404, never a 403, and never listed", async () => {
  const app = await buildTestApp();
  const ownerSub = `pg-a-${Date.now()}`;
  const otherSub = `pg-b-${Date.now()}`;
  try {
    await provision(app, ownerSub);
    await provision(app, otherSub);
    const ownerHeaders = await authHeader({ sub: ownerSub });
    const otherHeaders = await authHeader({ sub: otherSub });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: { name: "private", files: DRAFT_FILES },
      headers: ownerHeaders,
    });
    const draftId = created.json().id;

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/playground/drafts",
      headers: otherHeaders,
    });
    assert.ok(
      !listed.json().some((d: { id: string }) => d.id === draftId),
      "foreign draft must not be listed",
    );

    for (const [method, payload] of [
      ["GET", undefined],
      ["PUT", { name: "stolen" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/playground/drafts/${draftId}`,
        ...(payload ? { payload } : {}),
        headers: otherHeaders,
      });
      assert.equal(res.statusCode, 404, `${method} should 404 for non-owner`);
    }
  } finally {
    await app.close();
  }
});

test("drafts: HCL that does not parse still saves — a draft is a draft", async () => {
  const app = await buildTestApp();
  const sub = `pg-broken-${Date.now()}`;
  try {
    await provision(app, sub);
    const headers = await authHeader({ sub });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: {
        name: "wip",
        files: [{ path: "broken.tf", content: `resource "x" "y" {` }],
      },
      headers,
    });
    assert.equal(res.statusCode, 201);
  } finally {
    await app.close();
  }
});

test("drafts: shares the parse limits — count 400, size 413, extension 422", async () => {
  const app = await buildTestApp();
  const sub = `pg-limits-${Date.now()}`;
  try {
    await provision(app, sub);
    const headers = await authHeader({ sub });

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: {
        name: "big",
        files: Array.from({ length: 51 }, (_, i) => ({
          path: `f${i}.tf`,
          content: "#",
        })),
      },
      headers,
    });
    assert.equal(tooMany.statusCode, 400);

    const tooBig = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: {
        name: "huge",
        files: [{ path: "big.tf", content: "#".repeat(1024 * 1024 + 1) }],
      },
      headers,
    });
    assert.equal(tooBig.statusCode, 413);

    const badExt = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: {
        name: "nope",
        files: [{ path: "script.sh", content: "echo hi" }],
      },
      headers,
    });
    assert.equal(badExt.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("drafts: rename-only update works; an empty update body is a 422", async () => {
  const app = await buildTestApp();
  const sub = `pg-rename-${Date.now()}`;
  try {
    await provision(app, sub);
    const headers = await authHeader({ sub });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      payload: { name: "before", files: DRAFT_FILES },
      headers,
    });
    const draftId = created.json().id;

    const renamed = await app.inject({
      method: "PUT",
      url: `/api/v1/playground/drafts/${draftId}`,
      payload: { name: "after" },
      headers,
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "after");
    assert.deepEqual(renamed.json().files, DRAFT_FILES);

    const empty = await app.inject({
      method: "PUT",
      url: `/api/v1/playground/drafts/${draftId}`,
      payload: {},
      headers,
    });
    assert.equal(empty.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("drafts: every route requires a bearer token", async () => {
  const app = await buildTestApp();
  try {
    for (const [method, url, payload] of [
      ["POST", "/api/v1/playground/drafts", { name: "x", files: DRAFT_FILES }],
      ["GET", "/api/v1/playground/drafts", undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
      });
      assert.equal(res.statusCode, 401, `${method} ${url} should 401`);
    }
  } finally {
    await app.close();
  }
});
