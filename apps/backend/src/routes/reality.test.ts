/**
 * GP-208: ingesting a reality snapshot — the graph the user's CLI derived from
 * their state, never the state itself.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph } from "../graph/graph.js";
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
    payload: { name: "A", slug: `reality-${Date.now()}-${counter}` },
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

/** A raw `terraform.tfstate` — the thing that must never arrive. */
const RAW_STATE = {
  version: 4,
  terraform_version: "1.9.5",
  serial: 7,
  lineage: "9f4c0b1e-0000-4000-8000-000000000000",
  resources: [
    {
      mode: "managed",
      type: "azurerm_storage_account",
      name: "data",
      provider: 'provider["registry.terraform.io/hashicorp/azurerm"]',
      instances: [{ attributes: { name: "sa", primary_access_key: "AAAABBBB" } }],
    },
  ],
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

test("a derived reality graph is accepted and read back", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);

    const posted = await push(app, repo, REALITY, {
      terraform_version: "1.9.5",
    });
    assert.equal(posted.statusCode, 202);
    assert.equal(posted.json().nodes, 2);

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reality`,
    });
    assert.equal(read.statusCode, 200);
    const snapshot = read.json();
    assert.equal(snapshot.source, "state");
    assert.equal(snapshot.commitSha, "sha-main-1");
    assert.equal(snapshot.graph.nodes.length, 2);
    assert.equal(snapshot.stats.terraformVersion, "1.9.5");
  } finally {
    await app.close();
  }
});

test("a raw state file is refused, and the message explains the right flow", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const res = await push(app, repo, RAW_STATE);

    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /push-state/);
    assert.match(res.json().message, /never/i);

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reality`,
    });
    assert.equal(read.statusCode, 404, "nothing should have been stored");
  } finally {
    await app.close();
  }
});

test("a body that is not a graph at all is refused before anything is stored", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const res = await push(app, repo, { nodes: "not an array" });
    assert.equal(res.statusCode, 422);

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reality`,
    });
    assert.equal(read.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a new push replaces the previous reality — it is a state, not a history", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await push(app, repo, REALITY);
    await push(app, repo, {
      version: 1,
      nodes: [REALITY.nodes[0]],
      edges: [],
    });

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reality`,
    });
    assert.equal(read.json().graph.nodes.length, 1);

    const list = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/snapshots`,
    });
    assert.equal(
      list.json().filter((s: { source: string }) => s.source === "state").length,
      1,
      "one reality snapshot per repository, replaced in place",
    );
  } finally {
    await app.close();
  }
});

test("a wrong token is rejected", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repo.id}/state`,
      headers: { "x-groundplan-token": "nope" },
      payload: { ref: "main", commit_sha: "sha", payload: REALITY },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("a Kubernetes repository has no Terraform state — its reality is its cluster", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    counter += 1;
    const p = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      payload: { name: "A", slug: `reality-k8s-${Date.now()}-${counter}` },
    });
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${p.json().id}/repositories`,
      payload: {
        provider: "github",
        url: "https://github.com/acme/manifests",
        iacType: "kubernetes",
      },
    });
    const repo = { id: r.json().id as string, token: r.json().webhookToken as string };

    const res = await push(app, repo, REALITY);
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /kubernetes/i);
  } finally {
    await app.close();
  }
});

test("a repository nobody pushed a state for reads as 404, not as an empty estate", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/reality`,
    });
    assert.equal(read.statusCode, 404);
  } finally {
    await app.close();
  }
});
