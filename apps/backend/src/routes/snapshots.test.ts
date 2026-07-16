import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { seedOrg } from "../test-support.js";
import type { Graph } from "../graph/graph.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "S", slug: `snaproute-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return { projectId, repoId: r.json().id };
}

function graph(change: "create" | null): Graph {
  return {
    version: 1,
    nodes: [
      {
        id: "aws_s3_bucket.a",
        name: "a",
        type: "aws_s3_bucket",
        provider: "aws",
        module_path: [],
        change,
      },
    ],
    edges: [],
  };
}

test("snapshots list omits the graph, newest first; detail includes it", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "sha-hcl",
      graph: graph(null),
    });
    const planRow = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/pr-1",
      commitSha: "sha-plan",
      prNumber: 1,
      graph: graph("create"),
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots`,
    });
    assert.equal(list.statusCode, 200);
    const rows = list.json();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].commitSha, "sha-plan", "newest first");
    assert.ok(!("graph" in rows[0]), "list must not include the graph body");
    assert.equal(rows[0].stats.nodes, 1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${planRow.id}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().graph.nodes[0].id, "aws_s3_bucket.a");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("snapshots list filters by source and pr_number", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const { projectId, repoId } = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "h",
      graph: graph(null),
    });
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/pr-9",
      commitSha: "p9",
      prNumber: 9,
      graph: graph("create"),
    });

    const plans = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?source=plan`,
    });
    assert.equal(plans.json().length, 1);
    assert.equal(plans.json()[0].source, "plan");

    const pr9 = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?pr_number=9`,
    });
    assert.equal(pr9.json().length, 1);
    assert.equal(pr9.json()[0].prNumber, 9);

    const none = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?pr_number=404`,
    });
    assert.equal(none.json().length, 0);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("snapshots endpoints 404 for unknown repo / snapshot", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const missing = "00000000-0000-4000-8000-000000000000";
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${missing}/snapshots`,
    });
    assert.equal(list.statusCode, 404);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${missing}`,
    });
    assert.equal(detail.statusCode, 404);
  } finally {
    await app.close();
  }
});
