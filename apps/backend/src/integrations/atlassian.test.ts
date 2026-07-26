/**
 * Confluence over Atlassian OAuth 2.0 (3LO) — GP-197.
 *
 * The engine itself is covered by the GitLab tests; what matters here is that
 * an OAuth-connected org publishes with no per-repo credential, that the base
 * URL becomes the gateway (a 3LO token does not authenticate against the site's
 * own host), and that an already-published page is updated rather than
 * recreated after the credentials move.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { integrations } from "../db/schema.js";
import { seedOrg } from "../test-support.js";
import { confluenceAuthHeader } from "../services/confluence.js";
import { atlassianCredential, cloudApiBase } from "./atlassian.js";
import { clearAccessTokenCache, type OAuth2Http, type OAuth2TokenResponse } from "./oauth2.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const SITE = {
  id: "cloud-id-123",
  url: "https://acme.atlassian.net",
  name: "Acme",
};

function stubHttp(tokens: OAuth2TokenResponse[], resources: unknown = [SITE]) {
  const queue = [...tokens];
  const stub = {
    forms: [] as Record<string, string>[],
    urls: [] as string[],
    async token(url: string, form: Record<string, string>) {
      stub.urls.push(url);
      stub.forms.push(form);
      const next = queue.shift();
      if (!next) throw new Error("the stub ran out of scripted token responses");
      return next;
    },
    async getJson(url: string) {
      stub.urls.push(url);
      return resources;
    },
  };
  return stub as OAuth2Http & typeof stub;
}

function atlassianEnv(): AppEnv {
  return {
    ...env,
    atlassianClientId: "atl-client",
    atlassianClientSecret: "atl-secret",
    publicBaseUrl: "https://gp.example.com",
  };
}

/** Drive the whole connect round trip. */
async function connect(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
) {
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/integrations/oauth/start`,
    payload: { type: "atlassian" },
  });
  assert.equal(started.statusCode, 200, started.body);
  const state = new URL(started.json().authorizeUrl).searchParams.get("state");
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connections/complete`,
    payload: { state, params: { code: "auth-code" } },
  });
}

test("an OAuth access token is a Bearer header, like a Data Center PAT", () => {
  assert.equal(
    confluenceAuthHeader({
      baseUrl: cloudApiBase("cloud-id-123"),
      authType: "oauth",
      email: null,
      credential: "access-token",
    }),
    "Bearer access-token",
  );
});

test("the authorize URL names the Atlassian API audience and asks for offline access", async () => {
  const http = stubHttp([]);
  const app = await buildApp(atlassianEnv(), { oauth2Http: http });
  const orgId = await seedOrg(app);
  try {
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations/oauth/start`,
      payload: { type: "atlassian" },
    });
    assert.equal(started.statusCode, 200, started.body);
    const url = new URL(started.json().authorizeUrl);

    assert.equal(url.origin, "https://auth.atlassian.com");
    assert.equal(url.searchParams.get("audience"), "api.atlassian.com");
    assert.ok(url.searchParams.get("scope")?.includes("offline_access"));
    assert.ok(url.searchParams.get("scope")?.includes("write:confluence-content"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  } finally {
    await app.close();
  }
});

test("connecting stores the gateway base URL, the cloud id and an encrypted refresh token", async () => {
  const http = stubHttp([
    { access_token: "atl-access", refresh_token: "atl-refresh", expires_in: 3600 },
  ]);
  const app = await buildApp(atlassianEnv(), { oauth2Http: http });
  const orgId = await seedOrg(app);
  try {
    const completed = await connect(app, orgId);
    assert.equal(completed.statusCode, 201, completed.body);
    const integration = completed.json();

    assert.equal(integration.name, "Acme");
    assert.equal(integration.config.authType, "oauth");
    assert.equal(
      integration.config.baseUrl,
      "https://api.atlassian.com/ex/confluence/cloud-id-123",
      "a 3LO token authenticates against the gateway, not the site host",
    );
    assert.equal(integration.config.cloudId, "cloud-id-123");
    assert.equal(
      integration.config.siteUrl,
      "https://acme.atlassian.net",
      "the human URL is kept for links people click",
    );
    assert.equal(integration.credential, "***", "never handed back, in any mode");

    const [row] = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, integration.id));
    assert.notEqual(row!.credential, "atl-refresh");
    assert.equal(app.encryptor.decrypt(row!.credential), "atl-refresh");
  } finally {
    await app.close();
  }
});

test("reconnecting the same site keeps the integration id — published pages update, not duplicate", async () => {
  const http = stubHttp([
    { access_token: "a1", refresh_token: "r1", expires_in: 3600 },
    { access_token: "a2", refresh_token: "r2", expires_in: 3600 },
  ]);
  const app = await buildApp(atlassianEnv(), { oauth2Http: http });
  const orgId = await seedOrg(app);
  try {
    const first = await connect(app, orgId);
    const again = await connect(app, orgId);

    assert.equal(first.statusCode, 201);
    assert.equal(again.statusCode, 200, "the second time replaces in place");
    assert.equal(
      again.json().id,
      first.json().id,
      "the repo targets point at this id — changing it would orphan them",
    );

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/integrations`,
    });
    assert.equal(list.json().length, 1);
  } finally {
    await app.close();
  }
});

test("a grant covering no Confluence site is refused, not stored", async () => {
  const http = stubHttp(
    [{ access_token: "a1", refresh_token: "r1", expires_in: 3600 }],
    [],
  );
  const app = await buildApp(atlassianEnv(), { oauth2Http: http });
  const orgId = await seedOrg(app);
  try {
    const completed = await connect(app, orgId);
    assert.equal(completed.statusCode, 422);
    assert.match(completed.json().message, /no Confluence site/);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/integrations`,
    });
    assert.deepEqual(list.json(), []);
  } finally {
    await app.close();
  }
});

test("publishing an OAuth integration uses a freshly minted access token", async () => {
  clearAccessTokenCache();
  const http = stubHttp([
    { access_token: "a1", refresh_token: "r1", expires_in: 3600 },
    { access_token: "a2-refreshed", refresh_token: "r2", expires_in: 3600 },
  ]);
  const app = await buildApp(atlassianEnv(), { oauth2Http: http });
  const orgId = await seedOrg(app);
  try {
    const created = (await connect(app, orgId)).json();
    const [row] = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, created.id));

    const credential = await atlassianCredential(app, row!);
    assert.equal(
      credential,
      "a2-refreshed",
      "the stored refresh token is exchanged; the access token is never at rest",
    );
    assert.equal(
      app.encryptor.decrypt(
        (
          await app.db
            .select()
            .from(integrations)
            .where(eq(integrations.id, created.id))
        )[0]!.credential,
      ),
      "r2",
      "Atlassian rotates too — the spent refresh token must not stay stored",
    );
  } finally {
    await app.close();
  }
});

test("a stored token or PAT still authenticates unchanged", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const [row] = await app.db
      .insert(integrations)
      .values({
        organizationId: orgId,
        type: "atlassian",
        name: "Acme DC",
        config: {
          baseUrl: "https://confluence.acme.test",
          authType: "dc_pat",
          email: null,
        },
        credential: app.encryptor.encrypt("dc-pat-value"),
      })
      .returning();

    assert.equal(
      await atlassianCredential(app, row!),
      "dc-pat-value",
      "GP-179's modes are untouched — this is a third option, not a migration",
    );
  } finally {
    await app.close();
  }
});

test("without an Atlassian app configured, OAuth is not offered and cannot be started", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const catalog = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/integrations/oauth/providers`,
    });
    assert.deepEqual(catalog.json(), [{ type: "atlassian", connectable: false }]);

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations/oauth/start`,
      payload: { type: "atlassian" },
    });
    assert.equal(started.statusCode, 422);
    assert.match(started.json().message, /not configured here/);
  } finally {
    await app.close();
  }
});
