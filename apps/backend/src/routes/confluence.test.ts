/**
 * GP-179 (re-homed by GP-183): a repository's Confluence publish *target* — it
 * names an org Integration (which holds the credential) and the space its docs
 * land in. No credential ever passes through this endpoint; a cross-org
 * integration id is a 404; and configuring the target needs `project:manage`.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  authHeader,
  buildTestApp,
  seedOrg,
  seedOrgForDefaultUser,
} from "../test-support.js";
import type {
  ConfluenceClient,
  ConfluenceVerifyResult,
} from "../services/confluence.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** A stub Confluence for creating the org Integration these tests point at. */
function stubConfluence(result: ConfluenceVerifyResult = { ok: true, spaceName: null }) {
  const unused = async (): Promise<never> => {
    throw new Error("not used in these tests");
  };
  const stub: ConfluenceClient & { result: ConfluenceVerifyResult } = {
    result,
    async verifyCredential() {
      return stub.result;
    },
    verifySpace: unused,
    getPage: unused,
    createPage: unused,
    updatePage: unused,
    uploadAttachment: unused,
  };
  return stub;
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

async function seedIntegration(app: TestApp, orgId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/integrations`,
    payload: {
      type: "atlassian",
      name: "Acme Confluence",
      baseUrl: "https://acme.atlassian.net/wiki",
      authType: "dc_pat",
      credential: "pat",
    },
  });
  assert.equal(res.statusCode, 201);
  return res.json().id as string;
}

async function seedRepository(app: TestApp, orgId: string): Promise<string> {
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      payload: { name: "P", slug: `confluence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    })
  ).json();
  const repo = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
    payload: { url: "https://github.com/acme/infra" },
  });
  assert.equal(repo.statusCode, 201);
  return repo.json().id as string;
}

test("configure: the target names an org integration and a space, no credential", async () => {
  const app = await buildApp(env, { confluence: stubConfluence() });
  const orgId = await seedOrg(app);
  try {
    const integrationId = await seedIntegration(app, orgId);
    const repoId = await seedRepository(app, orgId);
    const base = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`;

    const created = await app.inject({
      method: "PUT",
      url: base,
      payload: { integrationId, spaceKey: "DOCS" },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.integrationId, integrationId);
    assert.equal(body.spaceKey, "DOCS");
    // No secret travels on a target — there is nothing to mask.
    assert.equal(body.credential, undefined);
    assert.equal(body.baseUrl, undefined);

    // A second save is an edit (200): move the space, keep the integration.
    const moved = await app.inject({
      method: "PUT",
      url: base,
      payload: { integrationId, spaceKey: "OPS" },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().spaceKey, "OPS");

    const got = await app.inject({ method: "GET", url: base });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().spaceKey, "OPS");
  } finally {
    await app.close();
  }
});

test("the chosen integration must belong to the repo's org — a cross-org id is a 404", async () => {
  const app = await buildApp(env, { confluence: stubConfluence() });
  try {
    const orgA = await seedOrg(app);
    const orgB = await seedOrg(app);
    const foreignIntegration = await seedIntegration(app, orgB);
    const repoId = await seedRepository(app, orgA);

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgA}/repositories/${repoId}/confluence`,
      payload: { integrationId: foreignIntegration, spaceKey: "DOCS" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("unconfigured is a 404; delete removes the target", async () => {
  const app = await buildApp(env, { confluence: stubConfluence() });
  const orgId = await seedOrg(app);
  try {
    const integrationId = await seedIntegration(app, orgId);
    const repoId = await seedRepository(app, orgId);
    const base = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`;

    assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: base })).statusCode, 404);

    await app.inject({ method: "PUT", url: base, payload: { integrationId, spaceKey: "DOCS" } });
    assert.equal((await app.inject({ method: "DELETE", url: base })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("configuring a target requires project:manage; reading does not", async () => {
  const app = await buildTestApp({ confluence: stubConfluence() });
  try {
    const member = await authHeader();
    const orgId = await seedOrgForDefaultUser(app, "member");
    const owner = await authHeader({ sub: "confluence-owner" });
    await app.inject({ method: "GET", url: "/api/v1/me", headers: owner });
    const { rows } = await app.pool.query(
      "select id from users where oidc_subject = $1",
      ["confluence-owner"],
    );
    await app.pool.query(
      "insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')",
      [rows[0].id, orgId],
    );

    const integrationId = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/integrations`,
        headers: owner,
        payload: {
          type: "atlassian",
          name: "Acme",
          baseUrl: "https://acme.atlassian.net/wiki",
          authType: "dc_pat",
          credential: "pat",
        },
      })
    ).json().id as string;
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects`,
        headers: owner,
        payload: { name: "P", slug: `confluence-rbac-${Date.now()}` },
      })
    ).json();
    const repoId = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
        headers: owner,
        payload: { url: "https://github.com/acme/infra" },
      })
    ).json().id as string;

    const base = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`;
    const payload = { integrationId, spaceKey: "DOCS" };

    // A member cannot configure or delete…
    assert.equal(
      (await app.inject({ method: "PUT", url: base, headers: member, payload })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "PUT", url: base, headers: owner, payload })).statusCode,
      201,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: base, headers: member })).statusCode,
      403,
    );
    // …but can see the target, like any repo setting.
    const got = await app.inject({ method: "GET", url: base, headers: member });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().integrationId, integrationId);
  } finally {
    await app.close();
  }
});
