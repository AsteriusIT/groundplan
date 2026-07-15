import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createRepo(app: FastifyInstance) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "P", slug: `pulls-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  const repo = r.json();
  return { projectId, repoId: repo.id, webhookToken: repo.webhookToken };
}

function planPayload(create: number) {
  return {
    format_version: "1.2",
    resource_changes: Array.from({ length: create }, (_, i) => ({
      address: `aws_s3_bucket.b${i}`,
      mode: "managed",
      type: "aws_s3_bucket",
      name: `b${i}`,
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: ["create"] },
    })),
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

test("pull_request event requires pr_number (422 without it)", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);
    const res = await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/f",
      commit_sha: "s1",
      payload: { hello: "world" },
    });
    assert.equal(res.statusCode, 422);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("two webhooks for the same PR upsert one row, update sha, keep both snapshots", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/feature-x",
      commit_sha: "sha-1",
      pr_number: 5,
      pr_title: "Add feature X",
      payload: planPayload(1),
    });
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/feature-x",
      commit_sha: "sha-2",
      pr_number: 5,
      payload: planPayload(3),
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/pulls`,
    });
    assert.equal(list.statusCode, 200);
    const pulls = list.json();
    assert.equal(pulls.length, 1, "same PR number → one row");
    assert.equal(pulls[0].number, 5);
    assert.equal(pulls[0].title, "Add feature X", "title preserved when omitted");
    assert.equal(pulls[0].latestCommitSha, "sha-2", "sha updated");
    // List carries the latest snapshot's stats without loading the graph.
    assert.equal(pulls[0].latestSnapshot.stats.changes.create, 3);
    assert.ok(!("graph" in pulls[0].latestSnapshot));

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/pulls/5`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().latestSnapshot.stats.changes.create, 3);

    // Both snapshots exist for this PR.
    const snaps = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/snapshots?pr_number=5`,
    });
    assert.equal(snaps.json().length, 2);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("pr_state=closed is reflected in the list", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/done",
      commit_sha: "c",
      pr_number: 8,
      pr_state: "closed",
      payload: planPayload(1),
    });
    // The list defaults to open PRs (GP-109), so a closed one is history —
    // reachable via ?status=closed, not the default view.
    const open = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/pulls`,
    });
    assert.equal(open.json().length, 0, "closed PRs are not in the default list");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/pulls?status=closed`,
    });
    assert.equal(list.json()[0].state, "closed");
    assert.ok(list.json()[0].closedAt, "a closed PR carries closedAt");
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("PR detail surfaces the parse error when there is no snapshot", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);
    await prWebhook(app, repoId, webhookToken, {
      ref: "refs/heads/broken",
      commit_sha: "bad-sha",
      pr_number: 3,
      payload: {
        format_version: "1.2",
        resource_changes: [
          { address: "", mode: "managed", type: "aws_s3_bucket", name: "x", change: { actions: ["create"] } },
        ],
      },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/pulls/3`,
    });
    assert.equal(detail.json().latestSnapshot, null);
    assert.ok(detail.json().parseError, "detail should expose the parse error");
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("unknown repo / PR number → 404", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const missing = "00000000-0000-4000-8000-000000000000";
    const badRepo = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${missing}/pulls`,
    });
    assert.equal(badRepo.statusCode, 404);
    const badPr = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/pulls/999`,
    });
    assert.equal(badPr.statusCode, 404);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
