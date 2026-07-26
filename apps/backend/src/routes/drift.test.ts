/**
 * GP-206: the drift ingestion endpoint and the read beside it.
 *
 * The push is a webhook, like every other thing a CI job sends us: a cron job
 * has a repository secret, not an OIDC bearer token. The read is org-scoped like
 * everything a tenant owns.
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
    payload: { name: "A", slug: `drift-route-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  const body = r.json();
  return { id: body.id as string, token: body.webhookToken as string };
}

const GRAPH: Graph = {
  version: 1,
  nodes: [
    {
      id: "azurerm_storage_account.data",
      name: "data",
      type: "azurerm_storage_account",
      provider: "azurerm",
      module_path: [],
      change: null,
    },
  ],
  edges: [],
};

const REFRESH_ONLY = {
  format_version: "1.2",
  resource_changes: [],
  resource_drift: [
    {
      address: "azurerm_storage_account.data",
      mode: "managed",
      type: "azurerm_storage_account",
      name: "data",
      provider_name: "registry.terraform.io/hashicorp/azurerm",
      change: {
        actions: ["update"],
        before: { min_tls_version: "TLS1_2", primary_access_key: "shhh" },
        after: { min_tls_version: "TLS1_0", primary_access_key: "shhh2" },
        before_sensitive: { primary_access_key: true },
        after_sensitive: { primary_access_key: true },
      },
    },
  ],
};

const PR_PLAN = {
  format_version: "1.2",
  resource_changes: [
    {
      address: "azurerm_storage_account.data",
      mode: "managed",
      type: "azurerm_storage_account",
      name: "data",
      change: { actions: ["create"], before: null, after: { name: "data" } },
    },
  ],
};

function push(
  app: FastifyInstance,
  repo: { id: string; token: string },
  payload: unknown,
  commitSha = "sha-main-1",
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repo.id}/drift`,
    headers: { "x-groundplan-token": repo.token },
    payload: { ref: "main", commit_sha: commitSha, payload },
  });
}

test("a refresh-only plan is accepted and readable as the repository's drift", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: "main",
      commitSha: "sha-main-1",
      graph: GRAPH,
    });

    const posted = await push(app, repo, REFRESH_ONLY);
    assert.equal(posted.statusCode, 202);
    assert.equal(posted.json().drifted, 1);

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/drift`,
    });
    assert.equal(read.statusCode, 200);
    const state = read.json();
    assert.equal(state.commitSha, "sha-main-1");
    assert.equal(state.stale, false);
    assert.equal(state.report.counts.total, 1);
    assert.equal(
      state.report.resources[0].address,
      "azurerm_storage_account.data",
    );
  } finally {
    await app.close();
  }
});

test("a pull-request plan pushed to the drift endpoint is refused, and says why", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const res = await push(app, repo, PR_PLAN);

    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /-refresh-only/);
    assert.match(res.json().message, /create/);

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/drift`,
    });
    assert.equal(read.statusCode, 404, "nothing should have been stored");
  } finally {
    await app.close();
  }
});

test("sensitive values never reach the stored report", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await push(app, repo, REFRESH_ONLY);

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/drift`,
    });
    const body = read.payload;
    assert.ok(!body.includes("shhh"), "a sensitive value leaked into the report");
    assert.ok(body.includes("(sensitive)"));
  } finally {
    await app.close();
  }
});

test("the report goes stale when main moves, and the read says so", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: "main",
      commitSha: "sha-main-1",
      graph: GRAPH,
    });
    await push(app, repo, REFRESH_ONLY);
    await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: "main",
      commitSha: "sha-main-2",
      graph: GRAPH,
    });

    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/drift`,
    });
    const state = read.json();
    assert.equal(state.stale, true);
    assert.equal(state.commitSha, "sha-main-1");
    assert.equal(state.baseCommitSha, "sha-main-2");
  } finally {
    await app.close();
  }
});

test("a wrong token is rejected before anything is read or stored", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repo.id}/drift`,
      headers: { "x-groundplan-token": "nope" },
      payload: { ref: "main", commit_sha: "sha", payload: REFRESH_ONLY },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("an unknown repository is a 404, not a hint that the endpoint exists", async () => {
  const app = await buildApp(env);
  await seedOrg(app);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/ci/11111111-1111-1111-1111-111111111111/drift",
      headers: { "x-groundplan-token": "whatever" },
      payload: { ref: "main", commit_sha: "sha", payload: REFRESH_ONLY },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a Kubernetes repository has no Terraform state to refresh", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    counter += 1;
    const p = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      payload: { name: "A", slug: `drift-k8s-${Date.now()}-${counter}` },
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

    const res = await push(app, repo, REFRESH_ONLY);
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /kubernetes/i);
  } finally {
    await app.close();
  }
});

test("a repository nobody measured reads as 404, not as a clean estate", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repo = await createRepo(app, orgId);
    const read = await app.inject({
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/drift`,
    });
    assert.equal(read.statusCode, 404);
  } finally {
    await app.close();
  }
});
