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
  ConfluenceTarget,
  ConfluenceVerifyResult,
} from "../services/confluence.js";

const env = loadEnv();

// Integration tests: real HTTP + Postgres (`docker compose up -d`).
before(async () => {
  await runMigrations(env.databaseUrl);
});

/** A stub Confluence that records what it was asked and answers as told. */
function stubConfluence(result: ConfluenceVerifyResult = { ok: true, spaceName: "Docs" }) {
  const seen: Array<{ target: ConfluenceTarget; spaceKey: string }> = [];
  // The connection stories never touch a page — publishing is GP-180's flow.
  const unused = async (): Promise<never> => {
    throw new Error("not used in these tests");
  };
  const stub: ConfluenceClient & { result: ConfluenceVerifyResult } = {
    result,
    async verifySpace(target, spaceKey) {
      seen.push({ target, spaceKey });
      return stub.result;
    },
    getPage: unused,
    createPage: unused,
    updatePage: unused,
    uploadAttachment: unused,
  };
  return { stub, seen };
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

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

const CLOUD_BODY = {
  baseUrl: "https://acme.atlassian.net/wiki/",
  spaceKey: "DOCS",
  authType: "cloud_token",
  email: "docs@acme.test",
  credential: "cloud-api-token",
};

test("configure: created verified, credential write-only and encrypted at rest", async () => {
  const { stub, seen } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const repoId = await seedRepository(app, orgId);

    const created = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: CLOUD_BODY,
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    // Write-only: the credential never comes back, in any response.
    assert.equal(body.credential, "***");
    // The base URL is stored without its trailing slash.
    assert.equal(body.baseUrl, "https://acme.atlassian.net/wiki");
    assert.equal(body.spaceKey, "DOCS");
    assert.equal(body.authType, "cloud_token");
    // Saving a credential is a claim the space is reachable — checked at once.
    assert.equal(body.connectionStatus, "ok");
    assert.ok(body.verifiedAt);

    // The verifier saw the plaintext and the normalized target.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.spaceKey, "DOCS");
    assert.equal(seen[0]?.target.credential, "cloud-api-token");
    assert.equal(seen[0]?.target.baseUrl, "https://acme.atlassian.net/wiki");

    // At rest the credential is AES-GCM ciphertext, not plaintext.
    const { rows } = await app.pool.query(
      "select credential from confluence_connections where repository_id = $1",
      [repoId],
    );
    assert.notEqual(rows[0].credential, "cloud-api-token");
    assert.equal(app.encryptor.decrypt(rows[0].credential), "cloud-api-token");

    // GET returns the config, still masked.
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().credential, "***");
  } finally {
    await app.close();
  }
});

test("a cloud token needs an email; a credential is required on first save", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const repoId = await seedRepository(app, orgId);

    const noEmail = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: { ...CLOUD_BODY, email: undefined },
    });
    assert.equal(noEmail.statusCode, 422);
    assert.equal(noEmail.json().fields[0].field, "email");

    const noCredential = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: { ...CLOUD_BODY, credential: undefined },
    });
    assert.equal(noCredential.statusCode, 422);
    assert.equal(noCredential.json().fields[0].field, "credential");

    // Not https → schema 422, nothing stored.
    const http = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: { ...CLOUD_BODY, baseUrl: "http://internal.acme.test" },
    });
    assert.equal(http.statusCode, 422);
  } finally {
    await app.close();
  }
});

test("update without a credential keeps the stored one; switching to a PAT drops the email", async () => {
  const { stub, seen } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const repoId = await seedRepository(app, orgId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: CLOUD_BODY,
    });

    // Move the space, say nothing about the credential: the stored one is kept
    // and the new target is re-verified with it.
    const moved = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: { ...CLOUD_BODY, credential: undefined, spaceKey: "OPS" },
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().spaceKey, "OPS");
    assert.equal(seen.at(-1)?.spaceKey, "OPS");
    assert.equal(seen.at(-1)?.target.credential, "cloud-api-token");

    // Switching to a DC PAT replaces the credential and has no email.
    const dc = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: {
        baseUrl: "https://confluence.acme.test",
        spaceKey: "OPS",
        authType: "dc_pat",
        credential: "dc-pat",
      },
    });
    assert.equal(dc.statusCode, 200);
    assert.equal(dc.json().authType, "dc_pat");
    assert.equal(dc.json().email, null);
    assert.equal(seen.at(-1)?.target.credential, "dc-pat");
  } finally {
    await app.close();
  }
});

test("verify categorizes: bad credential, unknown space, unreachable — and persists the outcome", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const repoId = await seedRepository(app, orgId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: CLOUD_BODY,
    });

    const url = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence/verify`;
    for (const error of ["auth_failed", "space_not_found", "network"] as const) {
      stub.result = { ok: false, error };
      const verify = await app.inject({ method: "POST", url });
      assert.equal(verify.statusCode, 200);
      assert.deepEqual(verify.json(), { ok: false, error });
    }

    // The last outcome is on the row.
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(got.json().connectionStatus, "failed");

    stub.result = { ok: true, spaceName: "Docs" };
    const ok = await app.inject({ method: "POST", url });
    assert.deepEqual(ok.json(), { ok: true });
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(after.json().connectionStatus, "ok");
  } finally {
    await app.close();
  }
});

test("unconfigured is a 404; delete removes the connection", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const repoId = await seedRepository(app, orgId);
    const base = `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`;

    assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 404);
    assert.equal(
      (await app.inject({ method: "POST", url: `${base}/verify` })).statusCode,
      404,
    );
    assert.equal((await app.inject({ method: "DELETE", url: base })).statusCode, 404);

    await app.inject({ method: "PUT", url: base, payload: CLOUD_BODY });
    assert.equal((await app.inject({ method: "DELETE", url: base })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("configuring Confluence requires project:manage; reading does not", async () => {
  const { stub } = stubConfluence();
  const app = await buildTestApp({ confluence: stub });
  try {
    const auth = await authHeader();
    const orgId = await seedOrgForDefaultUser(app, "member");
    // Seed the repository as a direct owner-less insert path is not available
    // here: members may not create projects, so use a second app with auth off?
    // No — a member can read but not manage; seed via an owner user instead.
    const owner = await authHeader({ sub: "confluence-owner" });
    await app.inject({ method: "GET", url: "/api/v1/me", headers: owner });
    // The default user is only a member; enrol the owner user too.
    const { rows } = await app.pool.query(
      "select id from users where oidc_subject = $1",
      ["confluence-owner"],
    );
    await app.pool.query(
      "insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')",
      [rows[0].id, orgId],
    );

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

    // A member cannot configure, verify or delete…
    const put = await app.inject({ method: "PUT", url: base, headers: auth, payload: CLOUD_BODY });
    assert.equal(put.statusCode, 403);

    const asOwner = await app.inject({ method: "PUT", url: base, headers: owner, payload: CLOUD_BODY });
    assert.equal(asOwner.statusCode, 201);

    assert.equal(
      (await app.inject({ method: "POST", url: `${base}/verify`, headers: auth })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: base, headers: auth })).statusCode,
      403,
    );
    // …but can see that a connection exists (masked), like any repo setting.
    const got = await app.inject({ method: "GET", url: base, headers: auth });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().credential, "***");
  } finally {
    await app.close();
  }
});
