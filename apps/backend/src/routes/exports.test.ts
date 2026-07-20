import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph } from "../graph/graph.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { seedOrg } from "../test-support.js";

const env: AppEnv = {
  ...loadEnv(),
  // Isolated cache dir so cache-hit assertions are not polluted by other runs.
  exportCacheDir: mkdtempSync(join(tmpdir(), "gp-export-test-")),
};

before(async () => {
  await runMigrations(env.databaseUrl);
});

const graph: Graph = {
  version: 2,
  nodes: [
    { id: "azurerm_virtual_network.this", name: "this", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: "create" },
    { id: "azurerm_subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: "create" },
    { id: "aws_s3_bucket.untouched", name: "untouched", type: "aws_s3_bucket", provider: "aws", module_path: [], change: "noop" },
  ],
  edges: [
    { from: "azurerm_subnet.a", to: "azurerm_virtual_network.this", kind: "depends_on" },
  ],
};

let counter = 0;
async function seedSnapshot(app: Awaited<ReturnType<typeof buildApp>>, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "X", slug: `exp-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/infra" },
  });
  const repoId = r.json().id;
  const snapshot = await insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "plan",
    ref: "refs/heads/pr-1",
    commitSha: "deadbeefcafe",
    prNumber: 1,
    graph,
  });
  return { projectId, snapshotId: snapshot.id };
}

test("export.svg renders an SVG, then serves the second request from cache", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, snapshotId } = await seedSnapshot(app, orgId);

    const first = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.svg` });
    assert.equal(first.statusCode, 200);
    assert.match(first.headers["content-type"] as string, /image\/svg\+xml/);
    assert.equal(first.headers["x-groundplan-cache"], "miss");
    assert.ok(first.payload.startsWith("<svg"));
    assert.ok(first.payload.includes("virtual_network"));

    const second = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.svg` });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers["x-groundplan-cache"], "hit");
    assert.equal(second.payload, first.payload);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("export.png returns a real PNG", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, snapshotId } = await seedSnapshot(app, orgId);
    const res = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.png` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/png");
    // PNG magic number.
    assert.equal(res.rawPayload.subarray(1, 4).toString("ascii"), "PNG");
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("?scope=changes renders a smaller image than the full graph", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, snapshotId } = await seedSnapshot(app, orgId);
    const full = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.svg?scope=full` });
    const changes = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.svg?scope=changes` });
    const fullRects = (full.payload.match(/rx="8"/g) ?? []).length;
    const changesRects = (changes.payload.match(/rx="8"/g) ?? []).length;
    // The untouched s3 bucket is dropped from the changes view.
    assert.equal(fullRects, 3);
    assert.equal(changesRects, 2);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("export.drawio returns a real mxfile and serves the second request from cache", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, snapshotId } = await seedSnapshot(app, orgId);

    const first = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.drawio` });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["content-type"], "application/vnd.jgraph.mxfile");
    assert.match(first.headers["content-disposition"] as string, /attachment; filename=".*\.drawio"/);
    assert.equal(first.headers["x-groundplan-cache"], "miss");
    // Real cells (not an image), openable by diagrams.net.
    assert.ok(first.payload.startsWith("<mxfile"));
    assert.ok(first.payload.includes('vertex="1"'));
    assert.ok(first.payload.includes('tooltip="azurerm_virtual_network.this"'));

    const second = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.drawio` });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers["x-groundplan-cache"], "hit");
    assert.equal(second.payload, first.payload);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("export.drawio always exports the full snapshot — a scope parameter is ignored", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, snapshotId } = await seedSnapshot(app, orgId);
    const full = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.drawio` });
    const scoped = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${snapshotId}/export.drawio?scope=changes` });
    assert.equal(scoped.statusCode, 200);
    // Same bytes as the full export: the untouched s3 bucket is still there.
    assert.equal(scoped.payload, full.payload);
    assert.ok(scoped.payload.includes("aws_s3_bucket.untouched"));
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("export endpoints 404 for an unknown snapshot", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const missing = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/snapshots/${missing}/export.svg` });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});
