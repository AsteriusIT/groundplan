import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

let counter = 0;
async function createProject(
  app: FastifyInstance,
  orgId: string,
  extra: Record<string, unknown> = {},
) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "C", slug: `ctx-${Date.now()}-${counter}`, ...extra },
  });
  return p;
}

async function createRepo(app: FastifyInstance, orgId: string, projectId: string) {
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: "https://github.com/acme/repo" },
  });
  return r.json().id as string;
}

test("project context: created null, editable via PATCH, returned by GET", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const created = await createProject(app, orgId);
    const projectId = created.json().id;
    assert.equal(created.json().contextMd, null);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/projects/${projectId}`,
      payload: { contextMd: "# Payments\n\nOwns billing." },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().contextMd, "# Payments\n\nOwns billing.");

    const got = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
    assert.equal(got.json().contextMd, "# Payments\n\nOwns billing.");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("project context can be set at creation time", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const created = await createProject(app, orgId, { contextMd: "seed context" });
    assert.equal(created.json().contextMd, "seed context");
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${created.json().id}` });
  } finally {
    await app.close();
  }
});

test("repository context is editable via PATCH and returned masked-safe", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const created = await createProject(app, orgId);
    const projectId = created.json().id;
    const repoId = await createRepo(app, orgId, projectId);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}`,
      payload: { contextMd: "This repo holds the VPC." },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().contextMd, "This repo holds the VPC.");
    // Editing context must never expose the PAT.
    assert.equal(patched.json().accessToken, null);

    const got = await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/repositories/${repoId}` });
    assert.equal(got.json().contextMd, "This repo holds the VPC.");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("context over the length limit is rejected", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const created = await createProject(app, orgId);
    const projectId = created.json().id;
    const tooLong = "x".repeat(50001);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/projects/${projectId}`,
      payload: { contextMd: tooLong },
    });
    assert.equal(res.statusCode, 422);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("PATCH project 404s for an unknown id", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/projects/00000000-0000-4000-8000-000000000000`,
      payload: { contextMd: "x" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});
