import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph, GraphNode } from "../graph/graph.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

function subnet(name: string): GraphNode {
  return {
    id: `azurerm_subnet.${name}`,
    name,
    type: "azurerm_subnet",
    provider: "azurerm",
    module_path: [],
    change: null,
  };
}
const docs = (names: string[]): Graph => ({ version: 1, nodes: names.map(subnet), edges: [] });

let counter = 0;
async function createRepo(app: Awaited<ReturnType<typeof buildApp>>, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "D", slug: `diff-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/infra" },
  });
  return { projectId, repoId: r.json().id };
}

test("diffs two docs snapshots by resource address", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const base = await insertGraphSnapshot(app.db, {
      repositoryId: repoId, source: "hcl", ref: "main", commitSha: "base0001", graph: docs(["a", "b"]),
    });
    const target = await insertGraphSnapshot(app.db, {
      repositoryId: repoId, source: "hcl", ref: "main", commitSha: "targ0002", graph: docs(["a", "c"]),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${base.id}/diff/${target.id}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.added.map((n: { id: string }) => n.id), ["azurerm_subnet.c"]);
    assert.deepEqual(body.removed.map((n: { id: string }) => n.id), ["azurerm_subnet.b"]);
    assert.equal(body.unchangedCount, 1);
    assert.equal(body.base.commitSha, "base0001");
    assert.equal(body.target.commitSha, "targ0002");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("rejects a plan-source snapshot pair (422)", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const hcl = await insertGraphSnapshot(app.db, {
      repositoryId: repoId, source: "hcl", ref: "main", commitSha: "h1", graph: docs(["a"]),
    });
    const plan = await insertGraphSnapshot(app.db, {
      repositoryId: repoId, source: "plan", ref: "pr", commitSha: "p1", prNumber: 1,
      graph: { version: 2, nodes: [{ ...subnet("a"), change: "create" }], edges: [] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${hcl.id}/diff/${plan.id}`,
    });
    assert.equal(res.statusCode, 422);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("rejects a cross-repository snapshot pair (422)", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const a = await createRepo(app, orgId);
    const b = await createRepo(app, orgId);
    const s1 = await insertGraphSnapshot(app.db, {
      repositoryId: a.repoId, source: "hcl", ref: "main", commitSha: "a1", graph: docs(["a"]),
    });
    const s2 = await insertGraphSnapshot(app.db, {
      repositoryId: b.repoId, source: "hcl", ref: "main", commitSha: "b1", graph: docs(["a"]),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${s1.id}/diff/${s2.id}`,
    });
    assert.equal(res.statusCode, 422);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${a.projectId}` });
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${b.projectId}` });
  } finally {
    await app.close();
  }
});

test("404 when a snapshot in the pair is unknown", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    const s1 = await insertGraphSnapshot(app.db, {
      repositoryId: repoId, source: "hcl", ref: "main", commitSha: "x1", graph: docs(["a"]),
    });
    const missing = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${s1.id}/diff/${missing}`,
    });
    assert.equal(res.statusCode, 404);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
