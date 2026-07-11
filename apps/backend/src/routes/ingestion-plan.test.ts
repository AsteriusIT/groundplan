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
    payload: { name: "P", slug: `planwh-${Date.now()}-${counter}` },
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

const planPayload = {
  format_version: "1.2",
  resource_changes: [
    {
      address: "aws_s3_bucket.logs",
      mode: "managed",
      type: "aws_s3_bucket",
      name: "logs",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: ["create"] },
    },
  ],
};

test("a plan webhook produces a linked graph snapshot", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: {
        ref: "refs/heads/feature",
        commit_sha: "abc123",
        event: "pull_request",
        pr_number: 42,
        payload: planPayload,
      },
    });
    assert.equal(res.statusCode, 202);

    const snaps = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/snapshots?source=plan`,
    });
    const rows = snaps.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prNumber, 42);
    assert.equal(rows[0].commitSha, "abc123");
    assert.equal(rows[0].stats.changes.create, 1);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a non-plan webhook stores no snapshot", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);
    await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: {
        ref: "refs/heads/main",
        commit_sha: "x",
        event: "push",
        payload: { hello: "world" },
      },
    });
    const snaps = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/snapshots`,
    });
    assert.equal(snaps.json().length, 0);
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a plan that fails to parse flags the event and still returns 202", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: {
        ref: "refs/heads/broken",
        commit_sha: "bad",
        event: "pull_request",
        pr_number: 7,
        // Detected as a plan, but the empty address makes the graph invalid.
        payload: {
          format_version: "1.2",
          resource_changes: [
            { address: "", mode: "managed", type: "aws_s3_bucket", name: "x", change: { actions: ["create"] } },
          ],
        },
      },
    });
    assert.equal(res.statusCode, 202, "ingestion must never fail on a parse error");

    const snaps = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/snapshots`,
    });
    assert.equal(snaps.json().length, 0, "nothing stored on parse failure");

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/events`,
    });
    const event = events.json()[0];
    assert.ok(event.parseError, "the event should carry a parse_error message");

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
