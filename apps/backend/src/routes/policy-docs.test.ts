/**
 * GP-203: compliance on main. The documentation of the default branch carries a
 * verdict, past versions keep the verdict they were given, the dashboard says
 * where each repository stands, comparing two versions compares their
 * violations, and a public share link stays free of all of it unless its creator
 * asked otherwise.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph, GraphNode } from "../graph/graph.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { evaluateRepositorySnapshot } from "../services/policy.js";
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
    payload: { name: "A", slug: `policy-docs-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return r.json().id as string;
}

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "type">): GraphNode {
  return {
    name: partial.id.split(".").pop() ?? partial.id,
    provider: "azurerm",
    module_path: [],
    change: null,
    ...partial,
  };
}

const EXPOSED = node({
  id: "azurerm_network_security_group.web",
  type: "azurerm_network_security_group",
  internet_exposed: true,
});
const CLEAN = node({
  id: "azurerm_network_security_group.web",
  type: "azurerm_network_security_group",
});

function graph(nodes: GraphNode[]): Graph {
  return { version: 4, nodes, edges: [] };
}

async function quietOrphanRule(app: FastifyInstance, orgId: string) {
  await app.inject({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/policy-config`,
    payload: { rules: { "orphan-resource": { enabled: false } } },
  });
}

test("a docs snapshot is judged, and the verdict is readable from the snapshot", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await quietOrphanRule(app, orgId);
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "aaaaaaa",
      graph: graph([EXPOSED]),
    });
    await evaluateRepositorySnapshot(app.db, snapshot);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${snapshot.id}/policy`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.report.status, "failing");
    // Documentation of a branch has nothing to be compared against.
    assert.equal(body.delta, null);
    assert.match(body.summaryMd, /\*\*Policy: failing\*\*/);
  } finally {
    await app.close();
  }
});

test("a snapshot that was never judged is judged on demand rather than left blank", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "bbbbbbb",
      graph: graph([EXPOSED]),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${snapshot.id}/policy`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().report.status, "failing");
  } finally {
    await app.close();
  }
});

test("comparing two versions compares their violations", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await quietOrphanRule(app, orgId);
    const before = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "1111111",
      graph: graph([EXPOSED]),
    });
    const after = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "2222222",
      graph: graph([CLEAN]),
    });
    await evaluateRepositorySnapshot(app.db, before);
    await evaluateRepositorySnapshot(app.db, after);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${before.id}/diff/${after.id}`,
    });
    assert.equal(res.statusCode, 200);
    const policy = res.json().policy;
    assert.deepEqual(
      policy.resolved.map((v: { ruleId: string }) => v.ruleId),
      ["nsg-open-to-internet"],
    );
    assert.deepEqual(policy.added, []);
  } finally {
    await app.close();
  }
});

test("the dashboard says where each repository stands, worst first", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    await quietOrphanRule(app, orgId);
    const failing = await createRepo(app, orgId);
    const passing = await createRepo(app, orgId);

    for (const [repoId, nodes] of [
      [failing, [EXPOSED]],
      [passing, [CLEAN]],
    ] as const) {
      const snapshot = await insertGraphSnapshot(app.db, {
        repositoryId: repoId,
        source: "hcl",
        ref: "main",
        commitSha: `sha-${repoId.slice(0, 6)}`,
        graph: graph([...nodes]),
      });
      await evaluateRepositorySnapshot(app.db, snapshot);
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/dashboard`,
    });
    const compliance = res.json().compliance as {
      repositoryId: string;
      status: string;
      counts: { error: number };
      checkedRules: number;
    }[];
    assert.equal(compliance.length, 2);
    assert.equal(compliance[0]!.repositoryId, failing);
    assert.equal(compliance[0]!.status, "failing");
    assert.equal(compliance[0]!.counts.error, 1);
    assert.ok(compliance[0]!.checkedRules > 0);
    assert.equal(compliance[1]!.status, "passing");
  } finally {
    await app.close();
  }
});

test("a repository nobody documented is absent from the compliance list, not passing", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    await createRepo(app, orgId);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/dashboard`,
    });
    assert.deepEqual(res.json().compliance, []);
  } finally {
    await app.close();
  }
});

test("a share link carries the compliance state only when it was asked for", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await quietOrphanRule(app, orgId);
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "ccccccc",
      graph: graph([EXPOSED]),
    });
    await evaluateRepositorySnapshot(app.db, snapshot);

    const quiet = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "docs_latest" },
    });
    assert.equal(quiet.json().includePolicy, false);
    const quietView = await app.inject({
      method: "GET",
      url: `/api/v1/public/${quiet.json().token}`,
    });
    assert.equal(quietView.json().policy, null);

    const open = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/share-links`,
      payload: { kind: "docs_latest", includePolicy: true },
    });
    assert.equal(open.json().includePolicy, true);
    const openView = await app.inject({
      method: "GET",
      url: `/api/v1/public/${open.json().token}`,
    });
    assert.equal(openView.json().policy.status, "failing");
  } finally {
    await app.close();
  }
});
