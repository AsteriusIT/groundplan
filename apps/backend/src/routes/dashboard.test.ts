import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import {
  buildTestApp,
  authHeader,
  seedOrg,
  seedOrgForDefaultUser,
} from "../test-support.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { reconcileRepositoryAnnotations } from "../services/annotation-reconcile.js";
import { insertGraphSnapshot } from "../services/graph-snapshots.js";

const env = loadEnv();

// Integration tests against the real HTTP + Postgres path. The dashboard reads
// the whole estate (there is no per-user ownership model yet), and test files
// run in parallel against one database — so every assertion here is about *our*
// fixtures (found by repository id) or about invariants that hold whatever else
// is in the table. Never about absolute global counts.
before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "P", slug: `dash-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  const repo = r.json();
  return { projectId, repoId: repo.id, webhookToken: repo.webhookToken };
}

/**
 * A risky plan: an NSG that allows inbound from the internet (⇒ `internet_exposed`)
 * and a Contributor grant over a whole subscription (⇒ `privileged`).
 */
function riskyPlan() {
  return {
    format_version: "1.2",
    resource_changes: [
      {
        address: "azurerm_network_security_group.open",
        mode: "managed",
        type: "azurerm_network_security_group",
        name: "open",
        provider_name: "registry.terraform.io/hashicorp/azurerm",
        change: {
          actions: ["create"],
          after: {
            security_rule: [
              {
                name: "allow-https",
                priority: 100,
                direction: "Inbound",
                access: "Allow",
                protocol: "Tcp",
                destination_port_range: "443",
                source_address_prefix: "Internet",
                destination_address_prefix: "*",
              },
            ],
          },
        },
      },
      {
        address: "azurerm_role_assignment.contributor_sub",
        mode: "managed",
        type: "azurerm_role_assignment",
        name: "contributor_sub",
        provider_name: "registry.terraform.io/hashicorp/azurerm",
        change: {
          actions: ["create"],
          after: {
            role_definition_name: "Contributor",
            scope: "/subscriptions/00000000-0000-0000-0000-000000000000",
            principal_id: "11111111-1111-1111-1111-111111111111",
          },
        },
      },
    ],
  };
}

/** A plain plan: one created bucket, no NSG and no role assignment. */
function quietPlan() {
  return {
    format_version: "1.2",
    resource_changes: [
      {
        address: "aws_s3_bucket.b",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "b",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["create"] },
      },
    ],
  };
}

async function prWebhook(
  app: FastifyInstance,
  repoId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repoId}`,
    headers: { "x-groundplan-token": token },
    payload: { event: "pull_request", ...body },
  });
}

function dashboard(app: FastifyInstance, orgId: string) {
  return app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/dashboard` });
}

test("stats are numbers and the lists are arrays, even with nothing attached", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const res = await dashboard(app, orgId);
    assert.equal(res.statusCode, 200);
    const body = res.json();

    // A fresh estate answers with zeroes and empty lists, never an error — and
    // that shape must hold no matter what other test files have inserted.
    for (const key of ["projects", "repositories", "openPrs", "orphanedAnnotations"]) {
      assert.equal(typeof body.stats[key], "number", `stats.${key} is a number`);
      assert.ok(body.stats[key] >= 0);
    }
    assert.ok(Array.isArray(body.recentPrs));
    assert.ok(Array.isArray(body.recentDocsSnapshots));
    assert.ok(Array.isArray(body.orphanRepositories));
  } finally {
    await app.close();
  }
});

test("a PR ingested via webhook appears in recentPrs with its change stats", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app, orgId);
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/feature-x",
      commit_sha: "sha-quiet",
      pr_number: 11,
      pr_title: "Add a bucket",
      payload: quietPlan(),
    });

    const body = (await dashboard(app, orgId)).json();
    const pr = body.recentPrs.find((p: { repositoryId: string }) => p.repositoryId === repoId);
    assert.ok(pr, "the ingested PR is in recentPrs");

    assert.equal(pr.number, 11);
    assert.equal(pr.title, "Add a bucket");
    assert.equal(pr.state, "open");
    // branch → target, so the row can render "feature-x → main".
    assert.equal(pr.sourceRef, "refs/heads/feature-x");
    assert.equal(pr.targetRef, "main");
    // Enough context to deep-link into the PR view.
    assert.equal(pr.projectId, projectId);
    assert.equal(pr.repositoryUrl, "https://github.com/acme/repo");
    // The stats of the PR's latest plan snapshot — one created bucket.
    assert.equal(pr.latestSnapshot.stats.changes.create, 1);
    assert.equal(pr.internetExposed, false);
    assert.equal(pr.privileged, false);

    assert.ok(body.stats.openPrs >= 1);
    assert.ok(body.stats.projects >= 1);
    assert.ok(body.stats.repositories >= 1);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("recentPrs flags a PR whose latest plan is internet-exposed and privileged", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app, orgId);
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/open-it-up",
      commit_sha: "sha-risky",
      pr_number: 12,
      payload: riskyPlan(),
    });

    const body = (await dashboard(app, orgId)).json();
    const pr = body.recentPrs.find((p: { repositoryId: string }) => p.repositoryId === repoId);
    assert.ok(pr);
    assert.equal(pr.internetExposed, true);
    assert.equal(pr.privileged, true);
    // No title was posted — the UI falls back to the number.
    assert.equal(pr.title, null);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("risk flags follow the latest plan snapshot, not an older one", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app, orgId);
    // First push exposes the NSG…
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/fix-it",
      commit_sha: "sha-1",
      pr_number: 13,
      payload: riskyPlan(),
    });
    // …the next one takes it away. The dashboard must reflect the newest plan.
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/fix-it",
      commit_sha: "sha-2",
      pr_number: 13,
      payload: quietPlan(),
    });

    const body = (await dashboard(app, orgId)).json();
    const pr = body.recentPrs.find((p: { repositoryId: string }) => p.repositoryId === repoId);
    assert.ok(pr);
    assert.equal(pr.internetExposed, false);
    assert.equal(pr.privileged, false);
    assert.equal(pr.latestSnapshot.stats.changes.create, 1);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("recentPrs is newest-first and never longer than 10", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app, orgId);
    for (const number of [1, 2, 3]) {
      await prWebhook(app, repoId, webhookToken, {
        ref: `refs/heads/f-${number}`,
        commit_sha: `sha-${number}`,
        pr_number: number,
        payload: quietPlan(),
      });
    }

    const body = (await dashboard(app, orgId)).json();
    assert.ok(body.recentPrs.length <= 10);

    const times: number[] = body.recentPrs.map((p: { updatedAt: string }) =>
      Date.parse(p.updatedAt),
    );
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1]! >= times[i]!, "recentPrs is ordered newest-first");
    }

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a PR without a parseable plan still lists, with no snapshot", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app, orgId);
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/no-plan",
      commit_sha: "sha-nop",
      pr_number: 21,
      payload: { hello: "world" },
    });

    const body = (await dashboard(app, orgId)).json();
    const pr = body.recentPrs.find((p: { repositoryId: string }) => p.repositoryId === repoId);
    assert.ok(pr);
    assert.equal(pr.latestSnapshot, null);
    assert.equal(pr.internetExposed, false);
    assert.equal(pr.privileged, false);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("orphaned annotations are counted and point at the repository to fix", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId } = await createRepo(app, orgId);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/annotations`,
      payload: { type: "note", anchors: ["aws_s3_bucket.gone"], body: "why" },
    });
    assert.equal(created.statusCode, 201);

    // Reconcile against a graph that no longer has the anchored address (what a
    // docs generation does, GP-57) — the annotation orphans.
    await reconcileRepositoryAnnotations(app.db, repoId, {
      version: 1,
      nodes: [],
      edges: [],
    });

    const body = (await dashboard(app, orgId)).json();
    assert.ok(body.stats.orphanedAnnotations >= 1);

    const hotspot = body.orphanRepositories.find(
      (r: { repositoryId: string }) => r.repositoryId === repoId,
    );
    assert.ok(hotspot, "the repository with orphans is listed so the card can link to it");
    assert.equal(hotspot.count, 1);
    assert.equal(hotspot.projectId, projectId);
    assert.equal(hotspot.repositoryUrl, "https://github.com/acme/repo");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("recentDocsSnapshots carry the sha, the trigger, and where to read them", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId } = await createRepo(app, orgId);
    // A docs snapshot as `generateDocsSnapshot` writes it — inserted directly so
    // the test stays offline (the real path clones the repository first).
    await insertGraphSnapshot(app.db, {
      repositoryId: repoId,
      source: "hcl",
      ref: "main",
      commitSha: "docs-sha-1",
      graph: { version: 1, nodes: [], edges: [] },
      extraStats: { warnings: [], trigger: "auto" },
    });

    const body = (await dashboard(app, orgId)).json();
    const docs = body.recentDocsSnapshots.find(
      (d: { repositoryId: string }) => d.repositoryId === repoId,
    );
    assert.ok(docs, "the docs snapshot is in recentDocsSnapshots");
    assert.equal(docs.commitSha, "docs-sha-1");
    assert.equal(docs.trigger, "auto");
    assert.equal(docs.projectId, projectId);
    assert.equal(docs.repositoryUrl, "https://github.com/acme/repo");
    assert.ok(body.recentDocsSnapshots.length <= 5);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("the dashboard requires authentication", async () => {
  const app = await buildTestApp();
  try {
    // Auth 401s before the org-scope guard runs, so the placeholder org is fine.
    const anonymous = await dashboard(app, "00000000-0000-4000-8000-000000000000");
    assert.equal(anonymous.statusCode, 401);

    // With a valid token the caller must reach an org they belong to.
    const orgId = await seedOrgForDefaultUser(app);
    const authed = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/dashboard`,
      headers: await authHeader(),
    });
    assert.equal(authed.statusCode, 200);
  } finally {
    await app.close();
  }
});
