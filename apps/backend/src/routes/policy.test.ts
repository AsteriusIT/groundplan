/**
 * GP-201: the policy configuration API. An organization turns rules on and off
 * and sets their severity; a repository overrides that, visibly; removing the
 * override returns it to the organization's configuration; a member reads but
 * cannot write; and a configuration change re-judges the documentation of main.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import type { Graph } from "../graph/graph.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";
import { getPolicyReport } from "../services/policy.js";
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
async function createRepo(app: FastifyInstance, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "A", slug: `policy-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id as string;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return { projectId, repoId: r.json().id as string };
}

/** A graph with one internet-exposed NSG — one `error` under the defaults. */
const EXPOSED: Graph = {
  version: 4,
  nodes: [
    {
      id: "azurerm_network_security_group.web",
      name: "web",
      type: "azurerm_network_security_group",
      provider: "azurerm",
      module_path: [],
      change: null,
      internet_exposed: true,
    },
  ],
  edges: [],
};

type CatalogEntry = {
  ruleId: string;
  enabled: boolean;
  severity: string;
  applicable: boolean;
  configured: boolean;
  title: string;
};

const entry = (catalog: CatalogEntry[], id: string): CatalogEntry =>
  catalog.find((r) => r.ruleId === id)!;

test("the org config lists the whole catalogue, defaults included", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/policy-config`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.rules, {});
    const nsg = entry(body.catalog, "nsg-open-to-internet");
    assert.equal(nsg.enabled, true);
    assert.equal(nsg.severity, "error");
    assert.equal(nsg.configured, false);
    assert.ok(nsg.title.length > 0);
    // A rule that is off until configured says so rather than lying about it.
    assert.equal(entry(body.catalog, "required-tags").enabled, false);
  } finally {
    await app.close();
  }
});

test("an org can disable a rule and change a severity, and it survives a re-read", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      payload: {
        rules: {
          "missing-tags": { enabled: false },
          "weak-tls": { severity: "error" },
          "required-tags": { enabled: true, params: { keys: ["environment"] } },
        },
      },
    });
    assert.equal(put.statusCode, 200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/policy-config`,
    });
    const catalog = res.json().catalog as CatalogEntry[];
    assert.equal(entry(catalog, "missing-tags").enabled, false);
    assert.equal(entry(catalog, "weak-tls").severity, "error");
    assert.equal(entry(catalog, "missing-tags").configured, true);
    assert.deepEqual(
      (entry(catalog, "required-tags") as unknown as { params: unknown }).params,
      { keys: ["environment"] },
    );
  } finally {
    await app.close();
  }
});

test("an unknown rule id is refused rather than silently dropped", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      payload: { rules: { "no-such-rule": { enabled: false } } },
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /unknown policy rule: no-such-rule/);
  } finally {
    await app.close();
  }
});

test("a repository override affects only that repository, and deleting it returns to the org config", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { repoId } = await createRepo(app, orgId);
    const other = await createRepo(app, orgId);

    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      payload: { rules: { "weak-tls": { severity: "error" } } },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/policy-config`,
      payload: { rules: { "nsg-open-to-internet": { enabled: false } } },
    });

    const overridden = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/policy-config`,
    });
    const body = overridden.json();
    // Inherited and overridden are both visible, and told apart.
    assert.deepEqual(body.inherited, { "weak-tls": { severity: "error" } });
    assert.deepEqual(body.override, { "nsg-open-to-internet": { enabled: false } });
    const catalog = body.catalog as CatalogEntry[];
    assert.equal(entry(catalog, "nsg-open-to-internet").enabled, false);
    assert.equal(entry(catalog, "nsg-open-to-internet").configured, true);
    // Inherited from the org: effective, but not this repository's doing.
    assert.equal(entry(catalog, "weak-tls").severity, "error");
    assert.equal(entry(catalog, "weak-tls").configured, false);

    // The neighbour is untouched.
    const neighbour = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${other.repoId}/policy-config`,
    });
    assert.equal(neighbour.json().override, null);
    assert.equal(
      entry(neighbour.json().catalog, "nsg-open-to-internet").enabled,
      true,
    );

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/policy-config`,
    });
    assert.equal(removed.statusCode, 204);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/policy-config`,
    });
    assert.equal(after.json().override, null);
    assert.deepEqual(after.json().rules, { "weak-tls": { severity: "error" } });
  } finally {
    await app.close();
  }
});

test("changing the configuration re-judges the documentation of main", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { repoId } = await createRepo(app, orgId);
    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "aaaaaaaa",
      graph: EXPOSED,
    });

    // No configuration yet: the defaults fail this snapshot.
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      payload: { rules: {} },
    });
    await app.flushBackgroundTasks();
    let stored = await getPolicyReport(app.db, snapshot.id);
    assert.equal(stored?.report.status, "failing");

    // Turn the rule off: main is re-judged without anybody touching the repo.
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      payload: { rules: { "nsg-open-to-internet": { enabled: false } } },
    });
    await app.flushBackgroundTasks();
    stored = await getPolicyReport(app.db, snapshot.id);
    assert.equal(stored?.report.status, "passing");
    // …and the configuration that judged it travels inside the report.
    const rule = stored?.report.rules.find(
      (r) => r.ruleId === "nsg-open-to-internet",
    );
    assert.equal(rule?.enabled, false);
  } finally {
    await app.close();
  }
});

test("a member reads the configuration but cannot change it", async () => {
  const app = await buildTestApp();
  const orgId = await seedOrgForDefaultUser(app, "member");
  try {
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      headers: await authHeader(),
    });
    assert.equal(read.statusCode, 200);

    const write = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/policy-config`,
      headers: await authHeader(),
      payload: { rules: { "weak-tls": { enabled: false } } },
    });
    assert.equal(write.statusCode, 403);
    assert.match(write.json().message, /policy:manage/);
  } finally {
    await app.close();
  }
});

test("another org's repository is not found, never forbidden", async () => {
  const app = await buildApp(env);
  const mine = await seedOrg(app);
  const theirs = await seedOrg(app, "Other Org");
  try {
    const { repoId } = await createRepo(app, theirs);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${mine}/repositories/${repoId}/policy-config`,
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});
