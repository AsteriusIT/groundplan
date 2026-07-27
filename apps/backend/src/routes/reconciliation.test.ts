/**
 * GP-209: the cloud compared with the code — what nothing here describes, what
 * nothing out there has, and what the two disagree about.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph } from "../graph/graph.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { seedOrg } from "../test-support.js";

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
    payload: { name: "A", slug: `reconcile-${Date.now()}-${counter}` },
  });
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${p.json().id}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  const body = r.json();
  return { id: body.id as string, token: body.webhookToken as string };
}

/** What the CLI derives: a plain graph, already sanitised. */
const REALITY: Graph = {
  version: 7,
  nodes: [
    {
      id: "azurerm_storage_account.data",
      name: "data",
      type: "azurerm_storage_account",
      provider: "azurerm",
      module_path: [],
      change: null,
      attributes: { location: "westeurope" },
    },
    {
      id: "azurerm_storage_account.unmanaged",
      name: "unmanaged",
      type: "azurerm_storage_account",
      provider: "azurerm",
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

function push(
  app: FastifyInstance,
  repo: { id: string; token: string },
  payload: unknown,
  over: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repo.id}/state`,
    headers: { "x-groundplan-token": repo.token },
    payload: { ref: "main", commit_sha: "sha-main-1", payload, ...over },
  });
}

test("the comparison names what is unmanaged, what is missing, and what disagrees", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    // The code declares `data` (in westeurope) and `declared`; the cloud has
    // `data` (in northeurope) and an `unmanaged` nobody wrote down.
    await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: "main",
      commitSha: "sha-main-1",
      graph: {
        version: 7,
        nodes: [
          {
            id: "azurerm_storage_account.data",
            name: "data",
            type: "azurerm_storage_account",
            provider: "azurerm",
            module_path: [],
            change: null,
            attributes: { location: "westeurope" },
          },
          {
            id: "azurerm_storage_account.declared",
            name: "declared",
            type: "azurerm_storage_account",
            provider: "azurerm",
            module_path: [],
            change: null,
          },
        ],
        edges: [],
      },
    });
    await push(app, repo, {
      version: 7,
      nodes: [
        {
          id: "azurerm_storage_account.data",
          name: "data",
          type: "azurerm_storage_account",
          provider: "azurerm",
          module_path: [],
          change: null,
          attributes: { location: "northeurope" },
        },
        {
          id: "azurerm_storage_account.unmanaged",
          name: "unmanaged",
          type: "azurerm_storage_account",
          provider: "azurerm",
          module_path: [],
          change: null,
        },
      ],
      edges: [],
    });

    const res = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reconciliation`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.deepEqual(body.unmanaged, ["azurerm_storage_account.unmanaged"]);
    assert.deepEqual(body.notApplied, ["azurerm_storage_account.declared"]);
    assert.deepEqual(body.divergent, ["azurerm_storage_account.data"]);
    assert.equal(body.graph.nodes.length, 3);
    assert.match(body.summaryMd, /not managed by this repository/i);
  } finally {
    await app.close();
  }
});

test("the comparison always names both sides — never presented as live", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: "main",
      commitSha: "sha-main-1",
      graph: REALITY,
    });
    await push(app, repo, REALITY, { commit_sha: "sha-main-1" });

    const res = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reconciliation`,
    });
    const body = res.json();
    assert.equal(body.code.commitSha, "sha-main-1");
    assert.ok(body.code.createdAt);
    assert.equal(body.reality.commitSha, "sha-main-1");
    assert.ok(body.reality.observedAt, "the reader must know how old this is");
  } finally {
    await app.close();
  }
});

test("with no reality pushed there is no view at all — not a misleading empty one", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: "main",
      commitSha: "sha-main-1",
      graph: REALITY,
    });

    const res = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reconciliation`,
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("with no documentation of main there is nothing to compare against either", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await push(app, repo, REALITY);

    const res = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reconciliation`,
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().message, /documentation/i);
  } finally {
    await app.close();
  }
});
