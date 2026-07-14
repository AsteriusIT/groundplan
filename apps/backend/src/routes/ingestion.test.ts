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
function uniqueSlug(): string {
  counter += 1;
  return `wh-${Date.now()}-${counter}`;
}

/** Create a project + repository, returning ids and the one-time webhook token. */
async function createRepo(app: FastifyInstance): Promise<{
  projectId: string;
  repoId: string;
  webhookToken: string;
}> {
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "WH", slug: uniqueSlug() },
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

const validBody = {
  ref: "refs/heads/main",
  commit_sha: "abc123",
  event: "push",
  payload: { hello: "world" },
};

test("webhook_token is returned once on create but never in the list", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, webhookToken } = await createRepo(app);
    assert.ok(webhookToken, "create response should include webhookToken");

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/repositories`,
    });
    assert.ok(
      !("webhookToken" in list.json()[0]),
      "list response must not include webhookToken",
    );
    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("valid webhook call stores an event and returns 202 with id", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: validBody,
    });
    assert.equal(res.statusCode, 202);
    assert.ok(res.json().id, "202 body should carry the event id");

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/events`,
    });
    assert.equal(events.statusCode, 200);
    const list = events.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].ref, "refs/heads/main");
    assert.equal(list[0].commitSha, "abc123");
    assert.equal(list[0].event, "push");
    assert.ok(list[0].receivedAt);
    assert.ok(!("payload" in list[0]), "events list must not include payload");

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("missing token -> 401, wrong token -> 401", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    const noToken = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      payload: validBody,
    });
    assert.equal(noToken.statusCode, 401);

    const badToken = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": "not-the-token" },
      payload: validBody,
    });
    assert.equal(badToken.statusCode, 401);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("unknown repository -> 404", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/ci/00000000-0000-4000-8000-000000000000",
      headers: { "x-groundplan-token": "anything" },
      payload: validBody,
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("malformed body -> 422", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: { ref: "refs/heads/main", event: "nope" }, // missing fields, bad enum
    });
    assert.equal(res.statusCode, 422);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("payload larger than 10 MB -> 413", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    const big = "x".repeat(11 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: { ...validBody, payload: { big } },
    });
    assert.equal(res.statusCode, 413);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("events list returns the last 20, newest first, without payload", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    for (let i = 1; i <= 21; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/webhooks/ci/${repoId}`,
        headers: { "x-groundplan-token": webhookToken },
        payload: { ...validBody, commit_sha: `sha-${i}` },
      });
      assert.equal(res.statusCode, 202);
    }

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/events`,
    });
    const list = events.json();
    assert.equal(list.length, 20, "should cap at 20");
    assert.equal(list[0].commitSha, "sha-21", "newest first");
    assert.ok(
      !list.some((e: { commitSha: string }) => e.commitSha === "sha-1"),
      "oldest (21st-from-top) event should be dropped",
    );

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

// --- GP-101: a repository refuses operations meant for the other kind ---

test("the plan webhook refuses a kubernetes repository", async () => {
  const app = await buildApp(env);
  try {
    const p = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "WH", slug: uniqueSlug() },
    });
    const projectId = p.json().id;
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/repositories`,
      payload: {
        provider: "github",
        url: "https://github.com/acme/manifests",
        iacType: "kubernetes",
      },
    });
    const { id: repoId, webhookToken } = r.json();

    // Explicit beats silent-empty: a manifests repo has no plan.json to send,
    // and saying so is more use than storing an event nothing will ever read.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/ci/${repoId}`,
      headers: { "x-groundplan-token": webhookToken },
      payload: validBody,
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /kubernetes/);

    // Nothing was stored — a refused delivery is not an event.
    const events = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/events`,
    });
    assert.deepEqual(events.json(), []);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
