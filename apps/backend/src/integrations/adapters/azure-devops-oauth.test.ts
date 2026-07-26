/**
 * Azure DevOps via Microsoft Entra ID (GP-196). The shared engine is already
 * covered by the GitLab tests; what matters here is the Entra shape — the right
 * login endpoints, the Azure DevOps resource scope, `offline_access`, and the
 * scope repeated on refresh (Entra requires it where GitLab refuses it).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { loadEnv, type AppEnv } from "../../config/env.js";
import { runMigrations } from "../../db/migrate.js";
import { integrationCredentials } from "../../db/schema.js";
import { seedOrg } from "../../test-support.js";
import type { EntraOAuthConfig } from "../config.js";
import type { OAuth2Http, OAuth2TokenResponse } from "../oauth2.js";
import { clearAccessTokenCache } from "../oauth2.js";
import {
  azureDevOpsConnectFlow,
  azureDevOpsOAuthStrategy,
  entraOAuthConfig,
} from "./azure-devops-oauth.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const config: EntraOAuthConfig = {
  clientId: "entra-client",
  clientSecret: "entra-secret",
  tenant: "organizations",
};

const REDIRECT = "https://gp.example.com/integrations/callback";
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

function stubHttp(tokens: OAuth2TokenResponse[], profile: unknown = {}) {
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
      return profile;
    },
  };
  return stub as OAuth2Http & typeof stub;
}

function entraEnv(): AppEnv {
  return {
    ...env,
    adoEntraClientId: config.clientId,
    adoEntraClientSecret: config.clientSecret,
    adoEntraTenant: config.tenant,
    publicBaseUrl: "https://gp.example.com",
  };
}

test("the endpoints are Entra's, and the scope is the Azure DevOps resource", () => {
  const oauth = entraOAuthConfig(config);

  assert.equal(
    oauth.authorizeUrl,
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  );
  assert.equal(
    oauth.tokenUrl,
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  );
  assert.equal(oauth.scope, `${ADO_RESOURCE}/.default offline_access`);
  assert.equal(
    oauth.refreshParams?.scope,
    oauth.scope,
    "Entra wants the scope back on every refresh",
  );
});

test("a single-tenant registration puts its tenant id in the login URL", () => {
  const oauth = entraOAuthConfig({ ...config, tenant: "contoso.onmicrosoft.com" });
  assert.match(oauth.authorizeUrl, /\/contoso\.onmicrosoft\.com\/oauth2/);
});

test("the authorize URL asks for offline access, so a refresh token is issued", () => {
  const flow = azureDevOpsConnectFlow(config, stubHttp([]));
  const url = new URL(
    flow.start({ redirectUri: REDIRECT }).authorizeUrl("sealed-state"),
  );

  assert.equal(url.host, "login.microsoftonline.com");
  assert.ok(url.searchParams.get("scope")?.includes("offline_access"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("completing names the connection after the profile that authorized it", async () => {
  const http = stubHttp(
    [{ access_token: "ado-access", refresh_token: "ado-refresh", expires_in: 3600 }],
    { displayName: "Alex Doe" },
  );
  const flow = azureDevOpsConnectFlow(config, http);
  const started = flow.start({ redirectUri: REDIRECT });

  const connection = await flow.complete({
    params: { code: "auth-code" },
    carry: started.carry,
    redirectUri: REDIRECT,
  });

  assert.equal(connection.name, "Azure DevOps · Alex Doe");
  assert.equal(connection.secret, "ado-refresh");
  assert.ok(
    http.urls.some((u) => u.startsWith("https://app.vssps.visualstudio.com/")),
    "the profile comes from vssps, not dev.azure.com",
  );
});

test("refreshing repeats the scope Entra requires", async () => {
  clearAccessTokenCache();
  const app = await buildApp(entraEnv());
  const orgId = await seedOrg(app);
  try {
    const [row] = await app.db
      .insert(integrationCredentials)
      .values({
        organizationId: orgId,
        provider: "azure_devops",
        mode: "oauth2",
        name: "Azure DevOps · Alex Doe",
        config: { account: "Alex Doe", instanceUrl: "entra:organizations" },
        secret: app.encryptor.encrypt("ado-refresh"),
        status: "ok",
      })
      .returning();

    const http = stubHttp([
      { access_token: "ado-access-2", refresh_token: "ado-refresh-2", expires_in: 3600 },
    ]);
    const strategy = azureDevOpsOAuthStrategy(app, row!, config, http);
    const token = await strategy.getToken();

    assert.equal(token.token, "ado-access-2");
    assert.equal(http.forms[0]?.grant_type, "refresh_token");
    assert.equal(
      http.forms[0]?.scope,
      `${ADO_RESOURCE}/.default offline_access`,
      "Entra refuses a refresh without it",
    );

    const [after] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, row!.id));
    assert.equal(app.encryptor.decrypt(after!.secret!), "ado-refresh-2");
  } finally {
    await app.close();
  }
});

test("Azure DevOps is connectable only where Entra is registered; PAT always remains", async () => {
  const configured = await buildApp(entraEnv());
  const bare = await buildApp(env);
  try {
    const orgA = await seedOrg(configured);
    const withEntra = (
      (
        await configured.inject({
          method: "GET",
          url: `/api/v1/orgs/${orgA}/connections/providers`,
        })
      ).json() as { id: string; connectableModes: string[]; credentialModes: string[] }[]
    ).find((p) => p.id === "azure_devops")!;
    assert.deepEqual(withEntra.connectableModes, ["oauth2"]);
    assert.ok(
      withEntra.credentialModes.includes("pat"),
      "Azure DevOps Server has no Entra tenant — the PAT never goes away",
    );

    const orgB = await seedOrg(bare);
    const without = (
      (
        await bare.inject({
          method: "GET",
          url: `/api/v1/orgs/${orgB}/connections/providers`,
        })
      ).json() as { id: string; connectableModes: string[] }[]
    ).find((p) => p.id === "azure_devops")!;
    assert.deepEqual(without.connectableModes, []);
  } finally {
    await configured.close();
    await bare.close();
  }
});
