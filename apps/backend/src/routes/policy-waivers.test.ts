/**
 * GP-204: waivers end to end. A reason is mandatory, the exemption is visible
 * rather than silent, an expired one stops suspending anything, the trail
 * records who did what, and a waiver whose resource disappears is orphaned the
 * way an annotation is — never deleted.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { memberships, policyWaivers } from "../db/schema.js";
import type { Graph, GraphNode } from "../graph/graph.js";
import { summarizePolicyDelta } from "../graph/policy/diff.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import {
  evaluateRepositorySnapshot,
  evaluateSnapshotPolicy,
  getPolicyReport,
} from "../services/policy.js";
import { reconcileRepositoryWaivers } from "../services/policy-waivers.js";
import {
  authHeader,
  buildTestApp,
  seedOrg,
  seedOrgForDefaultUser,
} from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string, headers = {}) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    headers,
    payload: { name: "A", slug: `waiver-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    headers,
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

function graph(nodes: GraphNode[]): Graph {
  return { version: 4, nodes, edges: [] };
}

async function quietOrphanRule(app: FastifyInstance, orgId: string, headers = {}) {
  await app.inject({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/policy-config`,
    headers,
    payload: { rules: { "orphan-resource": { enabled: false } } },
  });
}

async function docsOf(app: FastifyInstance, repoId: string, sha: string) {
  return insertGraphSnapshot(app.db, {
    repositoryId: repoId,
    source: "hcl",
    ref: "main",
    commitSha: sha,
    graph: graph([EXPOSED]),
  });
}

test("a waiver without a reason is refused", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
      },
    });
    assert.equal(res.statusCode, 422);

    const blank = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "",
      },
    });
    assert.equal(blank.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("waiving marks the violation and re-judges main, without hiding anything", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await quietOrphanRule(app, orgId);
    const snapshot = await docsOf(app, repoId, "aaaaaaa");
    await evaluateRepositorySnapshot(app.db, snapshot);
    assert.equal((await getPolicyReport(app.db, snapshot.id))?.report.status, "failing");

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "public ingress by design, reviewed 2026-07",
      },
    });
    assert.equal(created.statusCode, 201);

    const stored = await getPolicyReport(app.db, snapshot.id);
    // Still reported, still listed — marked and counted apart.
    assert.equal(stored?.report.violations.length, 1);
    assert.equal(stored?.report.counts.waived, 1);
    assert.equal(stored?.report.counts.error, 0);
    assert.equal(stored?.report.status, "passing");
    assert.match(stored!.summaryMd, /Waived/);
    assert.match(stored!.summaryMd, /public ingress by design/);
  } finally {
    await app.close();
  }
});

test("the same rule cannot be waived twice on one resource", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    const body = {
      ruleId: "nsg-open-to-internet",
      address: "azurerm_network_security_group.web",
      reason: "first",
    };
    const url = `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`;
    assert.equal((await app.inject({ method: "POST", url, payload: body })).statusCode, 201);
    const again = await app.inject({ method: "POST", url, payload: body });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("an expired waiver suspends nothing at the next report", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await quietOrphanRule(app, orgId);
    const snapshot = await docsOf(app, repoId, "bbbbbbb");

    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "temporary, until the WAF lands",
        expiresAt: "2026-07-20T00:00:00.000Z",
      },
    });

    // Judged the day before it expires: suspended.
    let row = await evaluateSnapshotPolicy(app.db, snapshot, {
      now: new Date("2026-07-19T00:00:00.000Z"),
    });
    assert.equal(row.report.counts.waived, 1);

    // Judged after: active again, and the verdict comes back with it.
    row = await evaluateSnapshotPolicy(app.db, snapshot, {
      now: new Date("2026-07-21T00:00:00.000Z"),
    });
    assert.equal(row.report.counts.waived, 0);
    assert.equal(row.report.status, "failing");
  } finally {
    await app.close();
  }
});

test("creating, extending and revoking are all on the record", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "reviewed",
      },
    });
    const waiverId = created.json().id as string;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/waivers/${waiverId}`,
      payload: { expiresAt: "2026-12-31T00:00:00.000Z" },
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/waivers/${waiverId}`,
    });
    assert.equal(revoked.statusCode, 204);

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waiver-events`,
    });
    assert.deepEqual(
      events.json().map((e: { action: string }) => e.action),
      ["revoked", "extended", "created"],
    );

    // Revoking does not delete: the row stays, so the trail still points at it.
    const [row] = await app.db
      .select()
      .from(policyWaivers)
      .where(eq(policyWaivers.id, waiverId));
    assert.ok(row?.revokedAt);

    // …and it no longer suspends anything: the live list is empty.
    const live = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
    });
    assert.deepEqual(live.json(), []);
  } finally {
    await app.close();
  }
});

test("a waiver whose resource disappears is orphaned, and comes back with it", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "reviewed",
      },
    });

    await reconcileRepositoryWaivers(
      app.db,
      repoId,
      graph([node({ id: "azurerm_subnet.a", type: "azurerm_subnet" })]),
    );
    let live = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
    });
    assert.equal(live.json()[0].status, "orphaned");

    await reconcileRepositoryWaivers(app.db, repoId, graph([EXPOSED]));
    live = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
    });
    assert.equal(live.json()[0].status, "active");
  } finally {
    await app.close();
  }
});

test("the pull-request comment tells waived apart from passing", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const repoId = await createRepo(app, orgId);
    await quietOrphanRule(app, orgId);
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "public ingress by design",
      },
    });

    const head = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "plan",
      ref: "refs/heads/feat",
      commitSha: "ccccccc",
      prNumber: 3,
      graph: graph([EXPOSED]),
    });
    const row = await evaluateRepositorySnapshot(app.db, head);

    const md = summarizePolicyDelta(row!.delta!, row!.report)!;
    assert.match(md, /1 new but waived/);
    assert.match(md, /New, but waived/);
    assert.match(md, /public ingress by design/);
    // Waived is not failing — but it is not silent either.
    assert.equal(row!.delta!.status, "passing");
  } finally {
    await app.close();
  }
});

test("a member may read waivers but not grant one", async () => {
  const app = await buildTestApp();
  // Seeded as owner so the repository can be created, then demoted — the point
  // of the test is what a member may do to an existing repository.
  const orgId = await seedOrgForDefaultUser(app, "owner");
  try {
    const headers = await authHeader();
    const repoId = await createRepo(app, orgId, headers);
    await app.db
      .update(memberships)
      .set({ role: "member" })
      .where(eq(memberships.organizationId, orgId));

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      headers,
    });
    assert.equal(read.statusCode, 200);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/waivers`,
      headers,
      payload: {
        ruleId: "nsg-open-to-internet",
        address: "azurerm_network_security_group.web",
        reason: "no",
      },
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().message, /policy:manage/);
  } finally {
    await app.close();
  }
});
