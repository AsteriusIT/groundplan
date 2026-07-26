/**
 * GP-206: storing a drift measurement beside the documentation of main, and
 * knowing when it stopped being about the main anybody is looking at.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { NotRefreshOnlyError } from "../graph/drift.js";
import type { Graph } from "../graph/graph.js";
import { insertGraphSnapshot } from "./graph-snapshots.js";
import { driftStateFor, recordDrift } from "./drift.js";
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
    payload: { name: "A", slug: `drift-svc-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return r.json().id as string;
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

function refreshOnlyPlan(after: string) {
  return {
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
          before: { min_tls_version: "TLS1_2" },
          after: { min_tls_version: after },
        },
      },
    ],
  };
}

async function docsOf(app: FastifyInstance, repositoryId: string, commitSha: string) {
  return insertGraphSnapshot(app.db, {
    repositoryId,
    source: "hcl",
    ref: "main",
    commitSha,
    graph: GRAPH,
  });
}

test("a measurement is stored against the sha it measured, and read back", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    const snapshot = await docsOf(app, repoId, "sha-main-1");

    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-1",
      plan: refreshOnlyPlan("TLS1_0"),
    });

    const state = await driftStateFor(app.db, repoId);
    assert.ok(state);
    assert.equal(state.commitSha, "sha-main-1");
    assert.equal(state.snapshotId, snapshot.id);
    assert.equal(state.report.counts.total, 1);
    assert.equal(state.stale, false);
    assert.equal(state.baseCommitSha, "sha-main-1");
    assert.match(state.summaryMd, /has drifted/);
  } finally {
    await app.close();
  }
});

test("re-measuring the same main replaces the measurement rather than stacking one", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await docsOf(app, repoId, "sha-main-1");

    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-1",
      plan: refreshOnlyPlan("TLS1_0"),
    });
    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-1",
      plan: refreshOnlyPlan("TLS1_1"),
    });

    const state = await driftStateFor(app.db, repoId);
    assert.equal(
      state?.report.resources[0]?.attribute_diff[0]?.after,
      "TLS1_1",
      "the newer measurement should have replaced the older",
    );
  } finally {
    await app.close();
  }
});

test("once main moves, the measurement is stale — never shown against the wrong sha", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await docsOf(app, repoId, "sha-main-1");
    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-1",
      plan: refreshOnlyPlan("TLS1_0"),
    });

    // A pull request merges: the poller documents the new main (GP-107).
    await docsOf(app, repoId, "sha-main-2");

    const state = await driftStateFor(app.db, repoId);
    assert.equal(state?.stale, true);
    assert.equal(state?.commitSha, "sha-main-1");
    assert.equal(state?.baseCommitSha, "sha-main-2");
  } finally {
    await app.close();
  }
});

test("measuring the new main clears the staleness", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await docsOf(app, repoId, "sha-main-1");
    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-1",
      plan: refreshOnlyPlan("TLS1_0"),
    });
    await docsOf(app, repoId, "sha-main-2");
    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-2",
      plan: refreshOnlyPlan("TLS1_0"),
    });

    const state = await driftStateFor(app.db, repoId);
    assert.equal(state?.stale, false);
    assert.equal(state?.commitSha, "sha-main-2");
  } finally {
    await app.close();
  }
});

test("a repository nobody measured has no drift state — not an empty one", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await docsOf(app, repoId, "sha-main-1");
    assert.equal(await driftStateFor(app.db, repoId), null);
  } finally {
    await app.close();
  }
});

test("drift can be measured before main has ever been documented", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await recordDrift(app.db, {
      repositoryId: repoId,
      ref: "main",
      commitSha: "sha-main-1",
      plan: refreshOnlyPlan("TLS1_0"),
    });

    const state = await driftStateFor(app.db, repoId);
    assert.equal(state?.snapshotId, null);
    assert.equal(state?.baseCommitSha, null);
    // Nothing to be stale against yet: main has no picture to disagree with.
    assert.equal(state?.stale, false);
  } finally {
    await app.close();
  }
});

test("a pull-request plan is refused rather than stored as drift", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await assert.rejects(
      recordDrift(app.db, {
        repositoryId: repoId,
        ref: "main",
        commitSha: "sha-main-1",
        plan: {
          format_version: "1.2",
          resource_changes: [
            {
              address: "a.b",
              mode: "managed",
              type: "a",
              name: "b",
              change: { actions: ["create"], before: null, after: {} },
            },
          ],
        },
      }),
      NotRefreshOnlyError,
    );
    assert.equal(await driftStateFor(app.db, repoId), null);
  } finally {
    await app.close();
  }
});
