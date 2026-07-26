/**
 * GitLab OAuth 2.0 (GP-195), and with it the shared OAuth engine every later
 * provider reuses: PKCE on the authorize URL, the code exchange, refresh-token
 * rotation, and the one failure that asks a human to reconnect.
 *
 * The identity provider is a stub — nothing here touches a network.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { loadEnv, type AppEnv } from "../../config/env.js";
import { runMigrations } from "../../db/migrate.js";
import { integrationCredentials } from "../../db/schema.js";
import { seedOrg } from "../../test-support.js";
import type { GitLabOAuthConfig } from "../config.js";
import { CredentialRevokedError } from "../types.js";
import {
  clearAccessTokenCache,
  OAuth2Error,
  type OAuth2Http,
  type OAuth2TokenResponse,
} from "../oauth2.js";
import { gitlabConnectFlow, gitlabOAuthStrategy } from "./gitlab-oauth.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const config: GitLabOAuthConfig = {
  clientId: "gp-client",
  clientSecret: "gp-secret",
  instanceUrl: "https://gitlab.example.com",
};

const REDIRECT = "https://gp.example.com/integrations/callback";

/** A scripted identity provider that records what it was asked. */
function stubHttp(script: {
  tokens?: OAuth2TokenResponse[];
  fail?: OAuth2Error;
  user?: unknown;
}): OAuth2Http & { forms: Record<string, string>[] } {
  const queue = [...(script.tokens ?? [])];
  const stub = {
    forms: [] as Record<string, string>[],
    async token(_url: string, form: Record<string, string>) {
      stub.forms.push(form);
      if (script.fail) throw script.fail;
      const next = queue.shift();
      if (!next) throw new Error("the stub ran out of scripted token responses");
      return next;
    },
    async getJson() {
      return script.user ?? { username: "acme-bot" };
    },
  };
  return stub;
}

function oauthEnv(): AppEnv {
  return {
    ...env,
    gitlabOauthClientId: config.clientId,
    gitlabOauthClientSecret: config.clientSecret,
    gitlabUrl: config.instanceUrl,
    publicBaseUrl: "https://gp.example.com",
  };
}

test("the authorize URL carries PKCE, and the verifier stays server-side", () => {
  const flow = gitlabConnectFlow(config, stubHttp({}));
  const started = flow.start({ redirectUri: REDIRECT });
  const url = new URL(started.authorizeUrl("sealed-state"));

  assert.equal(url.origin, "https://gitlab.example.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "gp-client");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("state"), "sealed-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");

  const verifier = started.carry.verifier!;
  assert.ok(verifier, "the verifier is carried, not published");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
    "the challenge is the S256 hash of the carried verifier",
  );
  assert.equal(
    url.toString().includes(verifier),
    false,
    "the verifier itself never reaches the browser",
  );

  assert.equal(
    url.searchParams.get("client_secret"),
    null,
    "a client secret never travels through the browser",
  );
});

test("completing exchanges the code with the verifier and stores the refresh token", async () => {
  const http = stubHttp({
    tokens: [
      {
        access_token: "glpat-access",
        refresh_token: "glpat-refresh",
        expires_in: 7200,
        scope: "api read_repository",
      },
    ],
    user: { username: "acme-bot" },
  });
  const flow = gitlabConnectFlow(config, http);
  const started = flow.start({ redirectUri: REDIRECT });

  const connection = await flow.complete({
    params: { code: "auth-code" },
    carry: started.carry,
    redirectUri: REDIRECT,
  });

  assert.deepEqual(http.forms[0], {
    grant_type: "authorization_code",
    code: "auth-code",
    client_id: "gp-client",
    client_secret: "gp-secret",
    redirect_uri: REDIRECT,
    code_verifier: started.carry.verifier!,
  });
  assert.equal(connection.name, "GitLab · acme-bot");
  assert.equal(connection.config.account, "acme-bot");
  assert.equal(
    connection.config.instanceUrl,
    "https://gitlab.example.com",
    "the connection remembers its instance, so a re-pointed deployment still refreshes it",
  );
  assert.equal(connection.secret, "glpat-refresh", "the durable half is what we keep");
});

test("a grant with no refresh token is refused instead of dying in an hour", async () => {
  const flow = gitlabConnectFlow(
    config,
    stubHttp({ tokens: [{ access_token: "glpat-access", expires_in: 7200 }] }),
  );
  const started = flow.start({ redirectUri: REDIRECT });

  await assert.rejects(
    () =>
      flow.complete({
        params: { code: "auth-code" },
        carry: started.carry,
        redirectUri: REDIRECT,
      }),
    /no refresh token/,
  );
});

test("a callback with no code, or with no verifier, is refused", async () => {
  const flow = gitlabConnectFlow(config, stubHttp({}));
  const started = flow.start({ redirectUri: REDIRECT });

  await assert.rejects(
    () =>
      flow.complete({ params: {}, carry: started.carry, redirectUri: REDIRECT }),
    /no authorization code/,
  );
  await assert.rejects(
    () =>
      flow.complete({
        params: { code: "auth-code" },
        carry: {},
        redirectUri: REDIRECT,
      }),
    /missing its verifier/,
  );
});

/** Seed a stored GitLab connection with a known refresh token. */
async function seedConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  refreshToken = "refresh-1",
) {
  const [row] = await app.db
    .insert(integrationCredentials)
    .values({
      organizationId: orgId,
      provider: "gitlab",
      mode: "oauth2",
      name: "GitLab · acme-bot",
      config: { account: "acme-bot", instanceUrl: config.instanceUrl },
      secret: app.encryptor.encrypt(refreshToken),
      status: "ok",
    })
    .returning();
  return row!;
}

test("a refreshed access token is cached, and its rotated refresh token persisted", async () => {
  clearAccessTokenCache();
  const app = await buildApp(oauthEnv());
  const orgId = await seedOrg(app);
  try {
    const row = await seedConnection(app, orgId, "refresh-1");
    const http = stubHttp({
      tokens: [
        { access_token: "access-1", refresh_token: "refresh-2", expires_in: 7200 },
      ],
    });

    const strategy = gitlabOAuthStrategy(app, row, config, http);
    const first = await strategy.getToken();
    const second = await strategy.getToken();

    assert.equal(first.token, "access-1");
    assert.equal(second.token, "access-1", "the cached token is reused");
    assert.equal(http.forms.length, 1, "one refresh, not two");
    assert.deepEqual(http.forms[0], {
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "gp-client",
      client_secret: "gp-secret",
    });

    const [after] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, row.id));
    assert.equal(
      app.encryptor.decrypt(after!.secret!),
      "refresh-2",
      "GitLab rotates on every refresh — the spent token must not stay stored",
    );
    assert.notEqual(after!.secret, "refresh-2", "and it is stored encrypted");
  } finally {
    await app.close();
  }
});

test("a rejected grant flips the connection to reconnect_required, once", async () => {
  clearAccessTokenCache();
  const app = await buildApp(oauthEnv());
  const orgId = await seedOrg(app);
  try {
    const row = await seedConnection(app, orgId);
    const http = stubHttp({
      fail: new OAuth2Error("refresh token is invalid", true),
    });

    const strategy = gitlabOAuthStrategy(app, row, config, http);
    await assert.rejects(
      () => strategy.getToken(),
      (err: unknown) => err instanceof CredentialRevokedError,
    );

    const [after] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, row.id));
    assert.equal(after!.status, "reconnect_required");
    assert.match(after!.lastError!, /reconnect/i);
  } finally {
    await app.close();
  }
});

test("a transient identity-provider failure does not condemn the connection", async () => {
  clearAccessTokenCache();
  const app = await buildApp(oauthEnv());
  const orgId = await seedOrg(app);
  try {
    const row = await seedConnection(app, orgId);
    const http = stubHttp({
      fail: new OAuth2Error("gitlab is having a bad day", false),
    });

    const strategy = gitlabOAuthStrategy(app, row, config, http);
    await assert.rejects(
      () => strategy.getToken(),
      (err: unknown) => err instanceof OAuth2Error && !(err instanceof CredentialRevokedError),
    );

    const [after] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, row.id));
    assert.equal(after!.status, "ok", "a bad night is not a revocation");
  } finally {
    await app.close();
  }
});

test("GitLab appears as connectable only where an OAuth app is configured", async () => {
  const configured = await buildApp(oauthEnv());
  const bare = await buildApp(env);
  const orgId = await seedOrg(configured);
  try {
    const withApp = await configured.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections/providers`,
    });
    const gitlab = (withApp.json() as { id: string; connectableModes: string[] }[]).find(
      (p) => p.id === "gitlab",
    )!;
    assert.deepEqual(gitlab.connectableModes, ["oauth2"]);

    const orgOnBare = await seedOrg(bare);
    const without = await bare.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgOnBare}/connections/providers`,
    });
    const bareGitlab = (
      without.json() as { id: string; connectableModes: string[] }[]
    ).find((p) => p.id === "gitlab")!;
    assert.deepEqual(bareGitlab.connectableModes, []);
  } finally {
    await configured.close();
    await bare.close();
  }
});

test("connecting GitLab end to end stores an encrypted refresh token", async () => {
  const http = stubHttp({
    tokens: [
      { access_token: "access-1", refresh_token: "refresh-1", expires_in: 7200 },
    ],
    user: { username: "acme-bot" },
  });
  const app = await buildApp(oauthEnv(), { oauth2Http: http });
  const orgId = await seedOrg(app);
  try {
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/start`,
      payload: { provider: "gitlab", mode: "oauth2" },
    });
    assert.equal(started.statusCode, 200, started.body);
    const state = new URL(started.json().authorizeUrl).searchParams.get("state");

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/complete`,
      payload: { state, params: { code: "auth-code" } },
    });
    assert.equal(completed.statusCode, 201, completed.body);
    const connection = completed.json();
    assert.equal(connection.provider, "gitlab");
    assert.equal(connection.mode, "oauth2");
    assert.equal(connection.name, "GitLab · acme-bot");

    const [row] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, connection.id));
    assert.notEqual(row!.secret, "refresh-1", "never plaintext at rest");
    assert.equal(app.encryptor.decrypt(row!.secret!), "refresh-1");
  } finally {
    await app.close();
  }
});
