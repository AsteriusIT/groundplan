import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { buildTestApp, authHeader } from "../test-support.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

// --- CRUD (unauthenticated; the RBAC guard lands in GP-114) -----------------

test("orgs CRUD: create -> get -> rename -> delete (confirmName)", async () => {
  const app = await buildApp(env);
  const slug = `org-${Date.now()}`;
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      payload: { name: "Acme", slug },
    });
    assert.equal(created.statusCode, 201);
    const org = created.json();
    assert.ok(org.id);
    assert.equal(org.name, "Acme");
    assert.equal(org.slug, slug);
    assert.ok(org.createdAt);

    const got = await app.inject({ method: "GET", url: `/api/v1/orgs/${org.id}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().slug, slug);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${org.id}`,
      payload: { name: "Acme Corp" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "Acme Corp");

    // Delete requires a matching confirmName.
    const noConfirm = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      payload: {},
    });
    assert.equal(noConfirm.statusCode, 422);

    const wrongConfirm = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      payload: { confirmName: "Nope" },
    });
    assert.equal(wrongConfirm.statusCode, 422);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      payload: { confirmName: "Acme Corp" },
    });
    assert.equal(del.statusCode, 204);

    const gone = await app.inject({ method: "GET", url: `/api/v1/orgs/${org.id}` });
    assert.equal(gone.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /orgs with a duplicate slug returns 409", async () => {
  const app = await buildApp(env);
  const slug = `dup-org-${Date.now()}`;
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      payload: { name: "First", slug },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      payload: { name: "Second", slug },
    });
    assert.equal(second.statusCode, 409);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${first.json().id}`,
      payload: { confirmName: "First" },
    });
  } finally {
    await app.close();
  }
});

test("POST /orgs with an invalid body returns 422 with field messages", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      payload: { slug: "Not A Slug!" }, // missing name, bad slug pattern
    });
    assert.equal(res.statusCode, 422);
    const fields = res.json().fields.map((f: { field: string }) => f.field);
    assert.ok(fields.includes("name"));
    assert.ok(fields.includes("slug"));
  } finally {
    await app.close();
  }
});

// --- Membership: the creator owns the org, members are readable -------------

test("creating an org (authenticated) makes the creator its owner", async () => {
  const app = await buildTestApp();
  const sub = `owner-sub-${Date.now()}`;
  const headers = await authHeader({ sub, email: "owner@example.com", name: "Owner" });
  const slug = `owned-${Date.now()}`;
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers,
      payload: { name: "Owned", slug },
    });
    assert.equal(created.statusCode, 201);
    const org = created.json();

    // GET /orgs lists the caller's memberships, with the role.
    const mine = await app.inject({ method: "GET", url: "/api/v1/orgs", headers });
    assert.equal(mine.statusCode, 200);
    const row = mine.json().find((o: { id: string }) => o.id === org.id);
    assert.ok(row, "created org should appear in the caller's org list");
    assert.equal(row.role, "owner");

    // Members list shows the creator as owner.
    const members = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${org.id}/members`,
      headers,
    });
    assert.equal(members.statusCode, 200);
    assert.equal(members.json().length, 1);
    assert.equal(members.json()[0].role, "owner");
    assert.equal(members.json()[0].email, "owner@example.com");

    await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      headers,
      payload: { confirmName: "Owned" },
    });
  } finally {
    await app.close();
  }
});

test("only an owner may delete an org (authenticated)", async () => {
  const app = await buildTestApp();
  const ownerSub = `del-owner-${Date.now()}`;
  const strangerSub = `del-stranger-${Date.now()}`;
  const owner = await authHeader({ sub: ownerSub, email: "o@example.com" });
  const stranger = await authHeader({ sub: strangerSub, email: "s@example.com" });
  const slug = `del-${Date.now()}`;
  try {
    const org = (
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs",
        headers: owner,
        payload: { name: "DelOrg", slug },
      })
    ).json();

    // A non-member cannot even see it (404, no existence leak) let alone delete.
    const strangerDel = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      headers: stranger,
      payload: { confirmName: "DelOrg" },
    });
    assert.equal(strangerDel.statusCode, 404);

    const ownerDel = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      headers: owner,
      payload: { confirmName: "DelOrg" },
    });
    assert.equal(ownerDel.statusCode, 204);
  } finally {
    await app.close();
  }
});

// --- Migration / backfill behaviour -----------------------------------------

test("a project created with no org lands in the Default org", async () => {
  const app = await buildApp(env);
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "Defaulted", slug: `defaulted-${Date.now()}` },
      })
    ).json();
    assert.ok(project.organizationId, "project should carry an organizationId");

    const org = (
      await app.inject({ method: "GET", url: `/api/v1/orgs/${project.organizationId}` })
    ).json();
    assert.equal(org.slug, "default");

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
  } finally {
    await app.close();
  }
});

test("a project can be created in an explicit org; unknown org is rejected", async () => {
  const app = await buildApp(env);
  const slug = `explicit-org-${Date.now()}`;
  try {
    const org = (
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs",
        payload: { name: "Explicit", slug },
      })
    ).json();

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        name: "In Org",
        slug: `in-org-${Date.now()}`,
        organizationId: org.id,
      },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().organizationId, org.id);

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        name: "No Org",
        slug: `no-org-${Date.now()}`,
        organizationId: "00000000-0000-0000-0000-000000000000",
      },
    });
    assert.equal(bad.statusCode, 422);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${org.id}`,
      payload: { confirmName: "Explicit" },
    });
  } finally {
    await app.close();
  }
});
