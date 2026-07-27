/**
 * Repository discovery (GP-227) end to end: an org with a GitHub App
 * installation asks what it can import, and gets the installation's exact scope
 * — paginated, searchable, and annotated with what is already attached.
 *
 * The GitHub App is configured with a throwaway keypair and a stub client that
 * pages, so a 250-repository installation is exercised with no network at all.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { integrationCredentials, projects, repositories } from "../db/schema.js";
import {
  GitHubAppError,
  type GitHubAppClient,
  type InstallationRepo,
} from "../integrations/adapters/github-app.js";
import { invalidateDiscoveryCache } from "../services/repo-discovery.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

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

function repo(n: number, overrides: Partial<InstallationRepo> = {}): InstallationRepo {
  return {
    id: n,
    full_name: `acme/repo-${n}`,
    name: `repo-${n}`,
    owner: { login: "acme" },
    clone_url: `https://github.com/acme/repo-${n}.git`,
    default_branch: "main",
    private: true,
    archived: false,
    updated_at: "2026-07-01T12:00:00Z",
    ...overrides,
  };
}

/** A stub App client over a fixed scope, paging 100 at a time like GitHub. */
function appClient(
  scope: InstallationRepo[],
  onList?: () => void,
): GitHubAppClient {
  return {
    getInstallation: async (id) => ({ id, account: "acme" }),
    createInstallationToken: async () => ({
      token: "ghs_x",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    listInstallationRepositories: async (_token, page) => {
      onList?.();
      const start = (page - 1) * 100;
      return {
        repositories: scope.slice(start, start + 100),
        totalCount: scope.length,
      };
    },
  };
}

/** Seed an org with a stored GitHub App connection, the GP-193 shape. */
async function seedConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  installationId = 42,
  name = "acme",
) {
  const [row] = await app.db
    .insert(integrationCredentials)
    .values({
      organizationId: orgId,
      provider: "github",
      mode: "installation_app",
      name,
      config: { installationId, account: name },
      secret: null,
      status: "ok",
    })
    .returning();
  return row!;
}

async function seedAttachedRepo(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  url: string,
  iacType: "terraform" | "kubernetes" = "terraform",
  terraformPath = "",
) {
  const [project] = await app.db
    .insert(projects)
    .values({
      organizationId: orgId,
      name: "Platform",
      slug: `platform-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    })
    .returning({ id: projects.id });
  const [row] = await app.db
    .insert(repositories)
    .values({ projectId: project!.id, provider: "github", url, iacType, terraformPath })
    .returning();
  return row!;
}

function discoveryUrl(orgId: string, query = ""): string {
  return `/api/v1/orgs/${orgId}/integrations/github/repositories${query}`;
}

test("an installation's repositories are listed with their real default branch", async () => {
  const scope = [
    repo(1, { default_branch: "trunk", private: false }),
    repo(2),
    repo(3, { archived: true }),
  ];
  const app = await buildApp(appEnv(), { githubApp: appClient(scope) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId);
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      repositories: {
        fullName: string;
        defaultBranch: string;
        private: boolean;
        archived: boolean;
        attachments: unknown[];
      }[];
      total: number;
      nextCursor: string | null;
    };
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.repositories.map((r) => r.fullName),
      ["acme/repo-1", "acme/repo-2", "acme/repo-3"],
    );
    assert.equal(body.repositories[0]!.defaultBranch, "trunk");
    assert.equal(body.repositories[0]!.private, false);
    assert.equal(body.repositories[1]!.private, true);
    // Archived repos come back flagged, never filtered: hiding them is the
    // UI's choice, and a frozen estate is a perfectly good thing to document.
    assert.equal(body.repositories[2]!.archived, true);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(body.repositories[0]!.attachments, []);
  } finally {
    await app.close();
  }
});

test("more than 100 repositories page transparently, none lost nor duplicated", async () => {
  const scope = Array.from({ length: 250 }, (_, i) => repo(i));
  const app = await buildApp(appEnv(), { githubApp: appClient(scope) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = cursor
        ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
        : "?limit=100";
      const res = await app.inject({
        method: "GET",
        url: discoveryUrl(orgId, query),
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as {
        repositories: { fullName: string }[];
        nextCursor: string | null;
        total: number;
      };
      assert.equal(body.total, 250);
      seen.push(...body.repositories.map((r) => r.fullName));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    assert.equal(seen.length, 250, "every repository is reachable");
    assert.equal(new Set(seen).size, 250, "no repository comes back twice");
  } finally {
    await app.close();
  }
});

test("search filters over the whole installation, not the page in hand", async () => {
  // The needle lives on GitHub's second page: a client-side filter would miss it.
  const scope = Array.from({ length: 250 }, (_, i) =>
    repo(i, i === 180 ? { full_name: "acme/needle", name: "needle" } : {}),
  );
  const app = await buildApp(appEnv(), { githubApp: appClient(scope) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId);
    const res = await app.inject({
      method: "GET",
      url: discoveryUrl(orgId, "?search=NEEDLE"),
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      repositories: { fullName: string }[];
      total: number;
    };
    assert.equal(body.total, 1);
    assert.equal(body.repositories[0]!.fullName, "acme/needle");
  } finally {
    await app.close();
  }
});

test("an already-attached repository is reported, with the kinds and paths in use", async () => {
  const scope = [repo(1)];
  const app = await buildApp(appEnv(), { githubApp: appClient(scope) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId);
    // Attached with a differently-spelled URL — same repository nonetheless.
    await seedAttachedRepo(app, orgId, "https://GitHub.com/acme/repo-1", "terraform", "infra");
    await seedAttachedRepo(app, orgId, "https://github.com/acme/repo-1.git", "kubernetes", "k8s");

    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 200, res.body);
    const [first] = (res.json() as {
      repositories: { attachments: { kind: string; path: string }[] }[];
    }).repositories;
    const attachments = [...first!.attachments].sort((a, b) =>
      a.kind.localeCompare(b.kind),
    );
    assert.deepEqual(
      attachments.map((a) => `${a.kind}:${a.path}`),
      ["kubernetes:k8s", "terraform:infra"],
      "a monorepo attached twice reports both attachments",
    );
  } finally {
    await app.close();
  }
});

test("another org's attachments never leak into this org's list", async () => {
  const scope = [repo(1)];
  const app = await buildApp(appEnv(), { githubApp: appClient(scope) });
  const orgId = await seedOrg(app);
  const otherOrgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId);
    await seedAttachedRepo(app, otherOrgId, "https://github.com/acme/repo-1");
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 200, res.body);
    const [first] = (res.json() as { repositories: { attachments: [] }[] }).repositories;
    assert.deepEqual(first!.attachments, []);
  } finally {
    await app.close();
  }
});

test("the scope is cached, so typing in the search box does not replay pagination", async () => {
  let calls = 0;
  const scope = Array.from({ length: 120 }, (_, i) => repo(i));
  const app = await buildApp(appEnv(), {
    githubApp: appClient(scope, () => {
      calls += 1;
    }),
  });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    const connection = await seedConnection(app, orgId);
    for (const search of ["re", "rep", "repo"]) {
      const res = await app.inject({
        method: "GET",
        url: discoveryUrl(orgId, `?search=${search}`),
      });
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.equal(calls, 2, "one full pagination (two pages) served all three");

    // An import must not be invisible for a minute: invalidation is immediate.
    invalidateDiscoveryCache(orgId, connection.id);
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(calls, 4, "after invalidation the scope is fetched again");
  } finally {
    await app.close();
  }
});

test("a revoked installation is a typed error, not an empty list", async () => {
  const failing: GitHubAppClient = {
    getInstallation: async () => {
      throw new GitHubAppError(404, "GitHub App API 404: Not Found");
    },
    createInstallationToken: async () => {
      throw new GitHubAppError(404, "GitHub App API 404: Not Found");
    },
    listInstallationRepositories: async () => {
      throw new GitHubAppError(404, "GitHub App API 404: Not Found");
    },
  };
  const app = await buildApp(appEnv(), { githubApp: failing });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId, 4242);
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json() as { code: string; message: string };
    assert.equal(body.code, "installation_revoked");
    assert.match(body.message, /no longer available/);
  } finally {
    await app.close();
  }
});

test("an installation forbidden from listing says so, distinctly from a revocation", async () => {
  const forbidden: GitHubAppClient = {
    getInstallation: async (id) => ({ id, account: "acme" }),
    createInstallationToken: async () => ({
      token: "ghs_x",
      expiresAt: new Date(Date.now() + 3_600_000),
    }),
    listInstallationRepositories: async () => {
      throw new GitHubAppError(403, "GitHub App API 403: Resource not accessible");
    },
  };
  const app = await buildApp(appEnv(), { githubApp: forbidden });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId, 77);
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { code: string }).code, "insufficient_permissions");
  } finally {
    await app.close();
  }
});

test("an org with no connection is told so, and never shown an empty list", async () => {
  const app = await buildApp(appEnv(), { githubApp: appClient([]) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { code: string }).code, "installation_not_linked");
  } finally {
    await app.close();
  }
});

test("several connections ask which one, listing the candidates", async () => {
  const app = await buildApp(appEnv(), { githubApp: appClient([repo(1)]) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId, 1, "acme");
    const second = await seedConnection(app, orgId, 2, "other-org");

    const ambiguous = await app.inject({
      method: "GET",
      url: discoveryUrl(orgId),
    });
    assert.equal(ambiguous.statusCode, 422, ambiguous.body);
    const body = ambiguous.json() as {
      code: string;
      connections: { id: string; name: string }[];
    };
    assert.equal(body.code, "multiple_connections");
    assert.deepEqual(
      body.connections.map((c) => c.name).sort(),
      ["acme", "other-org"],
    );

    const chosen = await app.inject({
      method: "GET",
      url: discoveryUrl(orgId, `?credentialId=${second.id}`),
    });
    assert.equal(chosen.statusCode, 200, chosen.body);
    assert.equal((chosen.json() as { credentialId: string }).credentialId, second.id);
  } finally {
    await app.close();
  }
});

test("an instance with no GitHub App refuses discovery instead of pretending", async () => {
  // No app configured: the provider has no discoverer, so there is no scope to
  // list — the honest answer, and the one that keeps the URL path open.
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    const res = await app.inject({ method: "GET", url: discoveryUrl(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { code: string }).code, "installation_not_linked");
  } finally {
    await app.close();
  }
});

test("discovery is scoped to the org in the path: another org's is a 404", async () => {
  const app = await buildApp(appEnv(), { githubApp: appClient([repo(1)]) });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedConnection(app, orgId);
    const res = await app.inject({
      method: "GET",
      url: discoveryUrl("00000000-0000-4000-8000-000000000000"),
    });
    assert.equal(res.statusCode, 404, res.body);
  } finally {
    await app.close();
  }
});
