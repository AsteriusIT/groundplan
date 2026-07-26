/**
 * Provider connections (GP-193): the catalog, the connect round trip, the
 * repository switch and revocation. The GitHub App is configured with a
 * throwaway keypair and a stub app client, so this exercises the whole flow
 * without a registered app or a network call.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import {
  integrationCredentials,
  projects,
  repositories,
} from "../db/schema.js";
import type { GitHubAppClient } from "../integrations/adapters/github-app.js";
import { GitHubAppError } from "../integrations/adapters/github-app.js";
import {
  authHeader,
  seedOrg,
  seedOrgForDefaultUser,
  testAuthEnv,
  testKeyResolver,
} from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Env with a fully-configured GitHub App and a public origin to return to. */
function appEnv(base: AppEnv = env): AppEnv {
  return {
    ...base,
    githubAppId: "12345",
    githubAppPrivateKey: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    githubAppSlug: "groundplan",
    publicBaseUrl: "https://gp.example.com",
  };
}

function stubGitHubApp(account: string | null = "acme-corp"): GitHubAppClient {
  return {
    getInstallation: async (installationId) => ({ id: installationId, account }),
    createInstallationToken: async () => ({
      token: "ghs_x",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
  };
}

/** A project + repository to switch onto a connection. */
async function seedRepo(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  provider: "github" | "gitlab" = "github",
) {
  const [project] = await app.db
    .insert(projects)
    .values({
      organizationId: orgId,
      name: "Platform",
      slug: `platform-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    })
    .returning({ id: projects.id });
  const [repo] = await app.db
    .insert(repositories)
    .values({
      projectId: project!.id,
      provider,
      url: `https://${provider === "github" ? "github.com" : "gitlab.com"}/acme/infra`,
    })
    .returning();
  return repo!;
}

/** Drive the whole connect round trip and return the created connection. */
async function connect(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  installationId = 42,
) {
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connections/start`,
    payload: { provider: "github", mode: "installation_app" },
  });
  assert.equal(started.statusCode, 200, started.body);
  const state = new URL(started.json().authorizeUrl).searchParams.get("state");

  const completed = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connections/complete`,
    payload: { state, params: { installation_id: String(installationId) } },
  });
  return completed;
}

test("the catalog is generated from the registry, with what this instance can connect", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections/providers`,
    });
    assert.equal(res.statusCode, 200);
    const catalog = res.json() as {
      id: string;
      label: string;
      connectableModes: string[];
      credentialModes: string[];
    }[];

    assert.deepEqual(
      catalog.map((p) => p.id),
      ["github", "gitlab", "azure_devops", "generic"],
      "every registered provider is offered — the UI hardcodes none of them",
    );
    const github = catalog.find((p) => p.id === "github")!;
    assert.deepEqual(github.connectableModes, ["installation_app"]);
    assert.ok(github.credentialModes.includes("pat"), "PAT stays available");
  } finally {
    await app.close();
  }
});

test("without a configured App, GitHub offers PAT only and cannot be connected", async () => {
  const app = await buildApp(env); // no GITHUB_APP_ID / private key
  const orgId = await seedOrg(app);
  try {
    const catalog = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections/providers`,
    });
    const github = (catalog.json() as { id: string; connectableModes: string[] }[]).find(
      (p) => p.id === "github",
    )!;
    assert.deepEqual(github.connectableModes, [], "nothing to connect here");

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/start`,
      payload: { provider: "github", mode: "installation_app" },
    });
    assert.equal(started.statusCode, 422);
    assert.match(started.json().message, /not configured here/);
  } finally {
    await app.close();
  }
});

test("connecting stores the installation and no secret, with an opaque state", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp("acme-corp") });
  const orgId = await seedOrg(app);
  try {
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/start`,
      payload: { provider: "github", mode: "installation_app" },
    });
    const url = new URL(started.json().authorizeUrl);
    assert.equal(url.host, "github.com");
    const state = url.searchParams.get("state")!;
    assert.ok(!state.includes(orgId), "the browser never sees which org is connecting");

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/complete`,
      payload: { state, params: { installation_id: "42" } },
    });
    assert.equal(completed.statusCode, 201, completed.body);
    const connection = completed.json();
    assert.equal(connection.provider, "github");
    assert.equal(connection.mode, "installation_app");
    assert.equal(connection.name, "acme-corp");
    assert.equal(connection.config.installationId, 42);
    assert.equal(connection.status, "ok");
    assert.equal(
      "secret" in connection,
      false,
      "a credential never travels back, not even masked",
    );

    const [row] = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, connection.id));
    assert.equal(row!.secret, null, "an App install stores nothing long-lived");
  } finally {
    await app.close();
  }
});

test("reconnecting the same installation replaces it in place, not beside it", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  try {
    const first = await connect(app, orgId, 42);
    const again = await connect(app, orgId, 42);

    assert.equal(first.statusCode, 201);
    assert.equal(again.statusCode, 200, "the second time updates rather than creating");
    assert.equal(again.json().id, first.json().id);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections`,
    });
    assert.equal(list.json().length, 1);
  } finally {
    await app.close();
  }
});

test("a tampered or foreign state is refused", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  const otherOrg = await seedOrg(app, "Other Org");
  try {
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/complete`,
      payload: { state: "not-a-sealed-state", params: { installation_id: "42" } },
    });
    assert.equal(forged.statusCode, 422);

    // A state minted for one org cannot bind an installation to another.
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${otherOrg}/connections/start`,
      payload: { provider: "github", mode: "installation_app" },
    });
    const state = new URL(started.json().authorizeUrl).searchParams.get("state");
    const crossed = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/complete`,
      payload: { state, params: { installation_id: "42" } },
    });
    assert.equal(crossed.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("an installation we cannot read is reported, never stored", async () => {
  const failing: GitHubAppClient = {
    getInstallation: async () => {
      throw new GitHubAppError(404, "GitHub App API 404: Not Found");
    },
    createInstallationToken: async () => {
      throw new GitHubAppError(404, "GitHub App API 404: Not Found");
    },
  };
  const app = await buildApp(appEnv(), { githubApp: failing });
  const orgId = await seedOrg(app);
  try {
    const completed = await connect(app, orgId, 999);
    assert.equal(completed.statusCode, 422);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections`,
    });
    assert.deepEqual(list.json(), []);
  } finally {
    await app.close();
  }
});

test("a repository switches onto the App and back to its PAT, losing nothing", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  try {
    const connection = (await connect(app, orgId)).json();
    const repo = await seedRepo(app, orgId);
    await app.db
      .update(repositories)
      .set({ accessToken: app.encryptor.encrypt("ghp_old_pat") })
      .where(eq(repositories.id, repo.id));

    const onto = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/credential`,
      payload: { credentialId: connection.id },
    });
    assert.equal(onto.statusCode, 200, onto.body);
    assert.equal(onto.json().authMode, "installation_app");

    const [afterSwitch] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo.id));
    assert.ok(
      afterSwitch!.accessToken,
      "the PAT is kept, so the move is reversible",
    );

    const back = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/credential`,
      payload: { credentialId: null },
    });
    assert.equal(back.statusCode, 200);
    assert.equal(back.json().credentialId, null);
  } finally {
    await app.close();
  }
});

test("a connection for the wrong provider cannot be attached to a repository", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  try {
    const connection = (await connect(app, orgId)).json();
    const repo = await seedRepo(app, orgId, "gitlab");

    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/credential`,
      payload: { credentialId: connection.id },
    });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().message, /github.*gitlab/);
  } finally {
    await app.close();
  }
});

test("revoking lists its impact first, then leaves repositories standing", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  try {
    const connection = (await connect(app, orgId)).json();
    const repo = await seedRepo(app, orgId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/credential`,
      payload: { credentialId: connection.id },
    });

    const impact = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections/${connection.id}/impact`,
    });
    assert.equal(impact.statusCode, 200);
    assert.deepEqual(
      impact.json().repositories.map((r: { id: string }) => r.id),
      [repo.id],
      "the user is told which repositories this would touch",
    );

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/connections/${connection.id}`,
    });
    assert.equal(revoked.statusCode, 204);

    const [after] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo.id));
    assert.ok(after, "revoking a connection never deletes a repository");
    assert.equal(after!.credentialId, null, "it degrades to no connection, honestly");
  } finally {
    await app.close();
  }
});

test("another org's connection is a 404, not a 403", async () => {
  const app = await buildApp(appEnv(), { githubApp: stubGitHubApp() });
  const orgId = await seedOrg(app);
  const otherOrg = await seedOrg(app, "Other Org");
  try {
    const connection = (await connect(app, orgId)).json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/orgs/${otherOrg}/connections/${connection.id}`,
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a member may read the catalog but not connect or revoke", async () => {
  // Auth on (so the RBAC matrix is exercised) *and* the App configured.
  const rbacApp = await buildApp(appEnv(testAuthEnv()), {
    githubApp: stubGitHubApp(),
    jwks: await testKeyResolver(),
  });
  try {
    const orgId = await seedOrgForDefaultUser(rbacApp, "member");
    const headers = await authHeader();

    const catalog = await rbacApp.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connections/providers`,
      headers,
    });
    assert.equal(catalog.statusCode, 200, "reading what exists is a member's right");

    const started = await rbacApp.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connections/start`,
      payload: { provider: "github", mode: "installation_app" },
      headers,
    });
    assert.equal(started.statusCode, 403, "connecting is owner/admin only");
  } finally {
    await rbacApp.close();
  }
});
