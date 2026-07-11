import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { InvalidGraphError, type Graph } from "../graph/graph.js";
import { insertGraphSnapshot } from "./graph-snapshots.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: Awaited<ReturnType<typeof buildApp>>) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "S", slug: `snap-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return { projectId, repoId: r.json().id };
}

const graph: Graph = {
  version: 1,
  nodes: [
    {
      id: "aws_s3_bucket.a",
      name: "a",
      type: "aws_s3_bucket",
      provider: "aws",
      module_path: [],
      change: "create",
    },
  ],
  edges: [],
};

test("insertGraphSnapshot computes stats and stores the snapshot", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const row = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/pr-1",
      commitSha: "deadbeef",
      prNumber: 7,
      graph,
    });
    assert.equal(row.source, "plan");
    assert.equal(row.prNumber, 7);
    assert.equal(row.stats.nodes, 1);
    assert.equal(row.stats.changes.create, 1);
    // GP-36: a deterministic summary is computed and stored on insert.
    assert.match(row.summaryMd, /\*\*\+1 created\*\* \(1 resource\)/);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("insertGraphSnapshot merges extraStats (e.g. warnings)", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const row = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "refs/heads/main",
      commitSha: "cafe",
      graph,
      extraStats: { warnings: ["skipped bad.tf"] },
    });
    assert.deepEqual(row.stats.warnings, ["skipped bad.tf"]);
    assert.equal(row.prNumber, null);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("insertGraphSnapshot rejects an invalid graph and stores nothing", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const bad = { version: 1, nodes: [{ id: "x" }], edges: [] } as unknown as Graph;
    await assert.rejects(
      () =>
        insertGraphSnapshot(app.db, {
          repositoryId: repoId,
          source: "plan",
          ref: "r",
          commitSha: "c",
          graph: bad,
        }),
      InvalidGraphError,
    );
    // Nothing was stored: the snapshots list is empty.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/snapshots`,
    });
    assert.equal(list.json().length, 0);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
