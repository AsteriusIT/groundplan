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
  return `set-${Date.now()}-${counter}`;
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
    payload: { name: "Set", slug: uniqueSlug() },
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

const pushBody = {
  ref: "refs/heads/main",
  commit_sha: "abc123",
  event: "push" as const,
  payload: { hello: "world" },
};

const post = (app: FastifyInstance, repoId: string, token: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repoId}`,
    headers: { "x-groundplan-token": token },
    payload: pushBody,
  });

test("regenerating a repo's webhook token invalidates the old one, shown once", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId, webhookToken } = await createRepo(app);

    // The old token works before the rotation.
    assert.equal((await post(app, repoId, webhookToken)).statusCode, 202);

    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/webhook-token`,
    });
    assert.equal(rotated.statusCode, 200);
    const next = rotated.json().webhookToken as string;
    assert.ok(next, "rotate response carries the new token, shown once");
    assert.notEqual(next, webhookToken, "the token actually changed");

    // The new token authenticates; the old one no longer does.
    assert.equal((await post(app, repoId, next)).statusCode, 202);
    assert.equal((await post(app, repoId, webhookToken)).statusCode, 401);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("rotating an unknown repository's token is a 404", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/repositories/00000000-0000-4000-8000-000000000000/webhook-token",
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("the app-wide token authenticates any repo, and revoking it stops that", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    // Generate the app-wide token (shown once here).
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/settings/ingestion/webhook-token",
    });
    assert.equal(created.statusCode, 201);
    const appToken = created.json().webhookToken as string;
    assert.ok(appToken, "the app-wide token is returned once on generate");

    try {
      // The status readout says it is set, and never leaks the value.
      const status = await app.inject({
        method: "GET",
        url: "/api/v1/settings/ingestion",
      });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().appWebhookTokenSet, true);
      assert.ok(status.json().updatedAt, "a set token records when it was set");
      assert.ok(
        !JSON.stringify(status.json()).includes(appToken),
        "the status must never carry the token value",
      );

      // A push with the app-wide token (and a wrong per-repo token) is accepted.
      assert.equal((await post(app, repoId, appToken)).statusCode, 202);
      // A token that is neither the repo's nor the app-wide one is still 401.
      assert.equal((await post(app, repoId, "nonsense")).statusCode, 401);
    } finally {
      // Revoke, so the global singleton is restored for other suites.
      const revoked = await app.inject({
        method: "DELETE",
        url: "/api/v1/settings/ingestion/webhook-token",
      });
      assert.equal(revoked.statusCode, 204);
    }

    // After revocation the app-wide token no longer authenticates.
    assert.equal((await post(app, repoId, appToken)).statusCode, 401);
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/settings/ingestion",
    });
    assert.equal(after.json().appWebhookTokenSet, false);
    assert.equal(after.json().updatedAt, null);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
