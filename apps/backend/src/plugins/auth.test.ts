import { test, before } from "node:test";
import assert from "node:assert/strict";

import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  authHeader,
  buildTestApp,
  signTestToken,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../test-support.js";

before(async () => {
  await runMigrations(loadEnv().databaseUrl);
});

test("GET /me without a token returns 401", async () => {
  const app = await buildTestApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/me" });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /me with an invalid signature returns 401", async () => {
  const app = await buildTestApp();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: "Bearer not.a.real.jwt" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /me with an expired token returns 401", async () => {
  const app = await buildTestApp();
  try {
    const token = await signTestToken({ expiresInSeconds: -60 });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /me with a wrong-audience token returns 401", async () => {
  const app = await buildTestApp();
  try {
    const token = await signTestToken({ audience: "some-other-api" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /me with a wrong-issuer token returns 401", async () => {
  const app = await buildTestApp();
  try {
    const token = await signTestToken({ issuer: "https://evil.example" });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("valid token -> 200, /me returns the user, and JIT-provisions once", async () => {
  const app = await buildTestApp();
  const sub = `user-${Date.now()}`;
  try {
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await authHeader({ sub, email: "a@example.com", name: "Ada" }),
    });
    assert.equal(first.statusCode, 200);
    const me = first.json();
    assert.ok(me.id);
    assert.equal(me.email, "a@example.com");
    assert.equal(me.display_name, "Ada");

    // Same subject, updated claims -> same user id (upsert, not duplicate).
    const second = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: await authHeader({ sub, email: "ada@example.com", name: "Ada L" }),
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().id, me.id);
    assert.equal(second.json().email, "ada@example.com");
  } finally {
    await app.close();
  }
});

test("protected API routes require a token, health/webhooks do not", async () => {
  const app = await buildTestApp();
  try {
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects" });
    assert.equal(projects.statusCode, 401, "projects must be protected");

    const healthz = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(healthz.statusCode, 200, "/healthz must be exempt");

    // Webhook is exempt from OIDC (it has its own token) -> 401 comes from the
    // webhook's own token check, not the OIDC layer (i.e. not a bearer 401).
    const webhook = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/ci/00000000-0000-4000-8000-000000000000",
      payload: { ref: "r", commit_sha: "s", event: "push", payload: {} },
    });
    assert.equal(webhook.statusCode, 404, "unknown repo -> 404, proving OIDC did not block");
  } finally {
    await app.close();
  }
});

test("issuer/audience constants are wired through", () => {
  assert.equal(TEST_ISSUER, "https://issuer.test.groundplan.local");
  assert.equal(TEST_AUDIENCE, "groundplan-test");
});
