/**
 * GP-183: organization-level Integrations. An external credential configured
 * once per org (type `atlassian`), attachable by N repositories. The credential
 * is write-only + encrypted at rest; managing an integration needs owner/admin;
 * a member may read the list; verify distinguishes a bad credential from a bad
 * URL; and an integration a repository still references cannot be deleted.
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
  ConfluenceTarget,
  ConfluenceVerifyResult,
} from "../services/confluence.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/** A stub Confluence that records the target it verified and answers as told. */
function stubConfluence(result: ConfluenceVerifyResult = { ok: true, spaceName: null }) {
  const seen: ConfluenceTarget[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not used in these tests");
  };
  const stub: ConfluenceClient & { result: ConfluenceVerifyResult } = {
    result,
    async verifyCredential(target) {
      seen.push(target);
      return stub.result;
    },
    verifySpace: unused,
    getPage: unused,
    createPage: unused,
    updatePage: unused,
    uploadAttachment: unused,
  };
  return { stub, seen };
}

const CLOUD_BODY = {
  type: "atlassian",
  name: "Acme Confluence",
  baseUrl: "https://acme.atlassian.net/wiki/",
  authType: "cloud_token",
  email: "docs@acme.test",
  credential: "cloud-api-token",
};

test("create: verified at once, config stored, credential write-only and encrypted at rest", async () => {
  const { stub, seen } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations`,
      payload: CLOUD_BODY,
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.type, "atlassian");
    assert.equal(body.name, "Acme Confluence");
    // The base URL is stored without its trailing slash.
    assert.equal(body.config.baseUrl, "https://acme.atlassian.net/wiki");
    assert.equal(body.config.authType, "cloud_token");
    assert.equal(body.config.email, "docs@acme.test");
    // Write-only: the credential never comes back, in any response.
    assert.equal(body.credential, "***");
    // Saving a credential is a claim we can reach the instance — checked at once.
    assert.equal(body.connectionStatus, "ok");
    assert.ok(body.verifiedAt);

    // The verifier saw the plaintext and the normalized target — no space.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.credential, "cloud-api-token");
    assert.equal(seen[0]?.baseUrl, "https://acme.atlassian.net/wiki");

    // At rest the credential is AES-GCM ciphertext, not plaintext.
    const { rows } = await app.pool.query(
      "select credential, config from integrations where id = $1",
      [body.id],
    );
    assert.notEqual(rows[0].credential, "cloud-api-token");
    assert.equal(app.encryptor.decrypt(rows[0].credential), "cloud-api-token");

    // List returns it, still masked.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/integrations`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
    assert.equal(list.json()[0].credential, "***");
  } finally {
    await app.close();
  }
});

test("a cloud token needs an email; a DC PAT does not carry one", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const noEmail = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations`,
      payload: { ...CLOUD_BODY, email: undefined },
    });
    assert.equal(noEmail.statusCode, 422);
    assert.equal(noEmail.json().fields[0].field, "email");

    // Not https → schema 422, nothing stored.
    const http = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations`,
      payload: { ...CLOUD_BODY, baseUrl: "http://internal.acme.test" },
    });
    assert.equal(http.statusCode, 422);

    const dc = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations`,
      payload: {
        type: "atlassian",
        name: "DC",
        baseUrl: "https://confluence.acme.test",
        authType: "dc_pat",
        credential: "dc-pat",
      },
    });
    assert.equal(dc.statusCode, 201);
    assert.equal(dc.json().config.email, null);
  } finally {
    await app.close();
  }
});

test("edit: rename without a credential keeps the stored one; switching to a PAT drops the email", async () => {
  const { stub, seen } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const id = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/integrations`,
        payload: CLOUD_BODY,
      })
    ).json().id as string;

    // Rename, say nothing about the credential: the stored one is kept and the
    // integration is re-verified with it.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/integrations/${id}`,
      payload: { name: "Renamed" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().name, "Renamed");
    assert.equal(seen.at(-1)?.credential, "cloud-api-token");

    // Switch to a DC PAT: new credential, and the email is dropped.
    const dc = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/integrations/${id}`,
      payload: {
        baseUrl: "https://confluence.acme.test",
        authType: "dc_pat",
        credential: "dc-pat",
      },
    });
    assert.equal(dc.statusCode, 200);
    assert.equal(dc.json().config.authType, "dc_pat");
    assert.equal(dc.json().config.email, null);
    assert.equal(seen.at(-1)?.credential, "dc-pat");
  } finally {
    await app.close();
  }
});

test("verify distinguishes a bad credential from a bad URL, and persists the outcome", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const id = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/integrations`,
        payload: CLOUD_BODY,
      })
    ).json().id as string;

    const url = `/api/v1/orgs/${orgId}/integrations/${id}/verify`;
    for (const error of ["auth_failed", "network"] as const) {
      stub.result = { ok: false, error };
      const verify = await app.inject({ method: "POST", url });
      assert.equal(verify.statusCode, 200);
      assert.deepEqual(verify.json(), { ok: false, error });
    }

    const failed = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/integrations/${id}`,
    });
    assert.equal(failed.json().connectionStatus, "failed");

    stub.result = { ok: true, spaceName: null };
    assert.deepEqual((await app.inject({ method: "POST", url })).json(), { ok: true });
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/integrations/${id}`,
    });
    assert.equal(ok.json().connectionStatus, "ok");
  } finally {
    await app.close();
  }
});

test("an integration a repository references cannot be deleted (409), and is gone once free", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  const orgId = await seedOrg(app);
  try {
    const integrationId = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/integrations`,
        payload: CLOUD_BODY,
      })
    ).json().id as string;

    // Attach it to a repository as that repo's Confluence target.
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects`,
        payload: { name: "P", slug: `int-del-${Date.now()}` },
      })
    ).json();
    const repoId = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/projects/${project.id}/repositories`,
        payload: { url: "https://github.com/acme/infra" },
      })
    ).json().id as string;
    const attached = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
      payload: { integrationId, spaceKey: "DOCS" },
    });
    assert.equal(attached.statusCode, 201);
    assert.equal(attached.json().integrationId, integrationId);

    // Referenced → 409, not deleted.
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/integrations/${integrationId}`,
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/integrations/${integrationId}` })).statusCode,
      200,
    );

    // Free it, then delete.
    await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/confluence`,
    });
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/integrations/${integrationId}` })).statusCode,
      204,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/orgs/${orgId}/integrations/${integrationId}` })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("a cross-org integration id is a 404, never another org's resource", async () => {
  const { stub } = stubConfluence();
  const app = await buildApp(env, { confluence: stub });
  try {
    const orgA = await seedOrg(app);
    const orgB = await seedOrg(app);
    const id = (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgA}/integrations`,
        payload: CLOUD_BODY,
      })
    ).json().id as string;

    // Addressed under org B (a member of B) → 404, no existence leak.
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/orgs/${orgB}/integrations/${id}`,
        ...(method === "PATCH" ? { payload: { name: "x" } } : {}),
      });
      assert.equal(res.statusCode, 404);
    }
    assert.equal(
      (await app.inject({ method: "POST", url: `/api/v1/orgs/${orgB}/integrations/${id}/verify` })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("managing integrations requires integration:manage; reading the list does not", async () => {
  const { stub } = stubConfluence();
  const app = await buildTestApp({ confluence: stub });
  try {
    const member = await authHeader();
    const orgId = await seedOrgForDefaultUser(app, "member");
    const owner = await authHeader({ sub: "integration-owner" });
    await app.inject({ method: "GET", url: "/api/v1/me", headers: owner });
    const { rows } = await app.pool.query(
      "select id from users where oidc_subject = $1",
      ["integration-owner"],
    );
    await app.pool.query(
      "insert into memberships (user_id, organization_id, role) values ($1, $2, 'owner')",
      [rows[0].id, orgId],
    );

    const base = `/api/v1/orgs/${orgId}/integrations`;

    // A member cannot create…
    assert.equal(
      (await app.inject({ method: "POST", url: base, headers: member, payload: CLOUD_BODY })).statusCode,
      403,
    );
    const created = await app.inject({ method: "POST", url: base, headers: owner, payload: CLOUD_BODY });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;

    // …edit, verify or delete…
    assert.equal(
      (await app.inject({ method: "PATCH", url: `${base}/${id}`, headers: member, payload: { name: "x" } })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: `${base}/${id}/verify`, headers: member })).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: `${base}/${id}`, headers: member })).statusCode,
      403,
    );

    // …but can read the list (name + status), masked.
    const list = await app.inject({ method: "GET", url: base, headers: member });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json()[0].name, "Acme Confluence");
    assert.equal(list.json()[0].credential, "***");
  } finally {
    await app.close();
  }
});
