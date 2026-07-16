import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../app.js";
import { buildTestApp, seedOrg } from "../test-support.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph } from "../graph/graph.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";

const env: AppEnv = {
  ...loadEnv(),
  exportCacheDir: mkdtempSync(join(tmpdir(), "gp-share-test-")),
};

before(async () => {
  await runMigrations(env.databaseUrl);
});

function docsGraph(name: string): Graph {
  return {
    version: 1,
    nodes: [
      { id: `azurerm_subnet.${name}`, name, type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
    ],
    edges: [],
  };
}

let counter = 0;
async function createRepo(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "S", slug: `share-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/infra" },
  });
  return { projectId, repoId: r.json().id };
}

test("docs_latest link resolves to the newest docs snapshot, no auth required", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const first = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "aaaaaaaa",
      graph: docsGraph("a"),
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "docs_latest" },
    });
    assert.equal(created.statusCode, 201);
    const { token } = created.json();
    assert.ok(typeof token === "string" && token.length >= 16);

    const view = await app.inject({ method: "GET", url: `/api/v1/public/${token}` });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().snapshot.commitSha, "aaaaaaaa");
    // No credentials leak into the public payload.
    const raw = view.payload;
    assert.ok(!raw.includes("accessToken"));
    assert.ok(!raw.includes("webhookToken"));

    // A newer docs snapshot → the same link now shows it.
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "bbbbbbbb",
      graph: docsGraph("b"),
    });
    void first;
    const after = await app.inject({ method: "GET", url: `/api/v1/public/${token}` });
    assert.equal(after.json().snapshot.commitSha, "bbbbbbbb");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("public view includes renderable annotations but hides orphans (GP-58)", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "cccccccc",
      graph: docsGraph("a"), // node id: azurerm_subnet.a
    });

    // One note anchored to a present node, one to a vanished node.
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/annotations`,
      payload: { type: "note", anchors: ["azurerm_subnet.a"], body: "kept" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/annotations`,
      payload: { type: "note", anchors: ["azurerm_subnet.gone"], body: "orphan" },
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "docs_latest" },
    });
    const { token } = created.json();

    const view = await app.inject({ method: "GET", url: `/api/v1/public/${token}` });
    assert.equal(view.statusCode, 200);
    const anns = view.json().annotations;
    assert.equal(anns.length, 1, "only the renderable annotation is public");
    assert.equal(anns[0].body, "kept");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a pinned snapshot link keeps its snapshot across regenerations", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const pinned = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "pinned01",
      graph: docsGraph("pin"),
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "snapshot", snapshotId: pinned.id },
    });
    assert.equal(created.statusCode, 201);
    const { token } = created.json();

    // Newer docs snapshot appears, but the pinned link is unchanged.
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "newer999",
      graph: docsGraph("newer"),
    });
    const view = await app.inject({ method: "GET", url: `/api/v1/public/${token}` });
    assert.equal(view.json().snapshot.commitSha, "pinned01");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("revoking a link makes the public route 404 immediately", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "cccccccc",
      graph: docsGraph("c"),
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "docs_latest" },
    });
    const { id, token } = created.json();

    assert.equal((await app.inject({ method: "GET", url: `/api/v1/public/${token}` })).statusCode, 200);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/share-links/${id}` });
    assert.equal(del.statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/public/${token}` })).statusCode, 404);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("public export.png renders for a share token", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "dddddddd",
      graph: docsGraph("d"),
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "docs_latest" },
    });
    const { token } = created.json();
    const png = await app.inject({ method: "GET", url: `/api/v1/public/${token}/export.png` });
    assert.equal(png.statusCode, 200);
    assert.equal(png.headers["content-type"], "image/png");
    assert.equal(png.rawPayload.subarray(1, 4).toString("ascii"), "PNG");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("pinning a snapshot from another repository is rejected (422)", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const a = await createRepo(app, orgId);
    const b = await createRepo(app, orgId);
    const foreign = await insertGraphSnapshot(app.db, {
      repositoryId: b.repoId,
      source: "hcl",
      ref: "main",
      commitSha: "eeeeeeee",
      graph: docsGraph("e"),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${a.repoId}/share-links`,
      payload: { kind: "snapshot", snapshotId: foreign.id },
    });
    assert.equal(res.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${a.projectId}` });
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${b.projectId}` });
  } finally {
    await app.close();
  }
});

test("unknown token → 404", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({ method: "GET", url: `/api/v1/public/${"z".repeat(32)}` });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("public routes are exempt from auth (404 from the handler, not 401)", async () => {
  // buildTestApp turns OIDC ON. A request to /public/* with NO bearer token must
  // reach the handler (unknown token → 404), proving the auth hook skips it.
  const app = await buildTestApp();
  try {
    const res = await app.inject({ method: "GET", url: `/api/v1/public/${"y".repeat(32)}` });
    assert.equal(res.statusCode, 404);
    // A protected route without a token still 401s — sanity that auth is on.
    const protectedRes = await app.inject({ method: "GET", url: "/api/v1/me" });
    assert.equal(protectedRes.statusCode, 401);
  } finally {
    await app.close();
  }
});
