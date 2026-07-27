/**
 * GitLab discovery end to end (GP-232).
 *
 * The point of these is that the *route* did not change: it took `:provider`
 * from the first day (GP-227), so adding GitLab is an adapter and a registry
 * entry. What is worth pinning is what is GitLab-specific — page-header
 * pagination, nested group namespaces, `internal` visibility, and the API base
 * coming from the connection so a self-managed instance needs no code.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv, type AppEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { integrationCredentials, projects } from "../db/schema.js";
import {
  GitLabApiError,
  type GitLabClient,
  type GitLabProject,
} from "../services/gitlab.js";
import type { OAuth2Http } from "../integrations/oauth2.js";
import { invalidateDiscoveryCache } from "../services/repo-discovery.js";
import { invalidateKindCache } from "../services/repo-kind-detect.js";
import { noGitLabRepoReads, seedOrg } from "../test-support.js";

const env = loadEnv();

before(async () => {
  await runMigrations(env.databaseUrl);
});

/**
 * The token endpoint, stubbed: a stored connection refreshes offline. Without
 * it every test here would try to reach gitlab.com and fail as `unavailable` —
 * which is exactly the kind of "test that touches the network" the injectable
 * collaborators exist to prevent.
 */
const offlineOAuth: OAuth2Http = {
  token: async () => ({
    access_token: "gl-access-token",
    refresh_token: "gl-refresh-token",
    expires_in: 3600,
  }),
  getJson: async () => ({}),
};

/** An instance with a registered GitLab OAuth application (GP-195). */
function oauthEnv(instance = "https://gitlab.com"): AppEnv {
  return {
    ...env,
    gitlabOauthClientId: "client-id",
    gitlabOauthClientSecret: "client-secret",
    gitlabUrl: instance,
    publicBaseUrl: "https://gp.example.com",
  };
}

function project(n: number, overrides: Partial<GitLabProject> = {}): GitLabProject {
  return {
    id: n,
    path_with_namespace: `acme/repo-${n}`,
    name: `repo-${n}`,
    path: `repo-${n}`,
    http_url_to_repo: `https://gitlab.com/acme/repo-${n}.git`,
    default_branch: "main",
    visibility: "private",
    archived: false,
    last_activity_at: "2026-07-01T00:00:00Z",
    namespace: { full_path: "acme" },
    ...overrides,
  };
}

/** A GitLab that pages its projects and records the API base it was asked. */
function fakeGitLab(projects: GitLabProject[]) {
  const seen: string[] = [];
  const client: GitLabClient = {
    ...noGitLabRepoReads,
    listMergeRequestNotes: async () => [],
    createMergeRequestNote: async () => ({ id: 1, body: "" }),
    updateMergeRequestNote: async () => ({ id: 1, body: "" }),
    listProjects: async (apiBase, _token, page) => {
      seen.push(apiBase);
      const start = (page - 1) * 100;
      const slice = projects.slice(start, start + 100);
      return {
        projects: slice,
        nextPage: start + slice.length < projects.length ? page + 1 : null,
      };
    },
  };
  return { client, seen };
}

async function seedGitLabConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  instanceUrl = "https://gitlab.com",
) {
  const [row] = await app.db
    .insert(integrationCredentials)
    .values({
      organizationId: orgId,
      provider: "gitlab",
      mode: "oauth2",
      name: "GitLab · tintin92350",
      config: { account: "tintin92350", instanceUrl },
      // The OAuth strategy needs a refresh token; these tests never mint one
      // because the stub client ignores the token it is handed.
      secret: app.encryptor.encrypt("refresh-token"),
      status: "ok",
    })
    .returning();
  return row!;
}

const url = (orgId: string, query = "") =>
  `/api/v1/orgs/${orgId}/integrations/gitlab/repositories${query}`;

test("a GitLab connection lists its projects, with visibility and branch", async () => {
  const { client } = fakeGitLab([
    project(1, { default_branch: "trunk", visibility: "public" }),
    // `internal` is not public: a clone still needs a credential.
    project(2, { visibility: "internal" }),
    project(3, { archived: true }),
  ]);
  const app = await buildApp(oauthEnv(), { gitlab: client, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);
    const res = await app.inject({ method: "GET", url: url(orgId) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      repositories: {
        fullName: string;
        defaultBranch: string;
        private: boolean;
        archived: boolean;
      }[];
      total: number;
    };
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.repositories.map((r) => r.fullName),
      ["acme/repo-1", "acme/repo-2", "acme/repo-3"],
    );
    assert.equal(body.repositories[0]!.defaultBranch, "trunk");
    assert.equal(body.repositories[0]!.private, false, "public is public");
    assert.equal(body.repositories[1]!.private, true, "internal is not public");
    assert.equal(body.repositories[2]!.archived, true);
  } finally {
    await app.close();
  }
});

test("more than 100 projects page transparently, none lost nor duplicated", async () => {
  const { client } = fakeGitLab(Array.from({ length: 250 }, (_, i) => project(i)));
  const app = await buildApp(oauthEnv(), { gitlab: client, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query: string = cursor
        ? `?limit=100&cursor=${encodeURIComponent(cursor)}`
        : "?limit=100";
      const res = await app.inject({ method: "GET", url: url(orgId, query) });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json() as {
        repositories: { fullName: string }[];
        nextCursor: string | null;
      };
      seen.push(...body.repositories.map((r) => r.fullName));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 250);
    assert.equal(new Set(seen).size, 250, "no project comes back twice");
  } finally {
    await app.close();
  }
});

test("a nested group namespace stays the owner, and the path is rebuildable", async () => {
  const { client } = fakeGitLab([
    project(1, {
      path_with_namespace: "acme/platform/infra",
      path: "infra",
      namespace: { full_path: "acme/platform" },
      http_url_to_repo: "https://gitlab.com/acme/platform/infra.git",
    }),
  ]);
  const app = await buildApp(oauthEnv(), { gitlab: client, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);
    const res = await app.inject({ method: "GET", url: url(orgId) });
    const [repo] = (res.json() as {
      repositories: { owner: string; name: string; fullName: string }[];
    }).repositories;
    assert.equal(repo!.owner, "acme/platform");
    assert.equal(repo!.name, "infra");
    // `${owner}/${name}` must reconstruct the project path — the tree reader
    // addresses projects that way.
    assert.equal(`${repo!.owner}/${repo!.name}`, repo!.fullName);
  } finally {
    await app.close();
  }
});

test("a self-managed instance is read from the connection, not from the code", async () => {
  const { client, seen } = fakeGitLab([project(1)]);
  // The deployment points at gitlab.com; the *connection* was made elsewhere.
  const app = await buildApp(oauthEnv("https://gitlab.com"), { gitlab: client, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId, "https://git.acme.internal");
    const res = await app.inject({ method: "GET", url: url(orgId) });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(seen, ["https://git.acme.internal/api/v4"]);
  } finally {
    await app.close();
  }
});

test("a refused connection is a typed error, not an empty list", async () => {
  const { client } = fakeGitLab([]);
  const failing: GitLabClient = {
    ...client,
    listProjects: async () => {
      throw new GitLabApiError(401, "GitLab API 401: Unauthorized");
    },
  };
  const app = await buildApp(oauthEnv(), { gitlab: failing, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);
    const res = await app.inject({ method: "GET", url: url(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { code: string }).code, "installation_revoked");
  } finally {
    await app.close();
  }
});

test("a connection without the scopes to list says so, distinctly", async () => {
  const { client } = fakeGitLab([]);
  const forbidden: GitLabClient = {
    ...client,
    listProjects: async () => {
      throw new GitLabApiError(403, "GitLab API 403: Forbidden");
    },
  };
  const app = await buildApp(oauthEnv(), { gitlab: forbidden, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);
    const res = await app.inject({ method: "GET", url: url(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { code: string }).code, "insufficient_permissions");
  } finally {
    await app.close();
  }
});

test("an instance with no OAuth application cannot discover, and says so", async () => {
  const { client } = fakeGitLab([project(1)]);
  const app = await buildApp(env, { gitlab: client, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);
    const res = await app.inject({ method: "GET", url: url(orgId) });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((res.json() as { code: string }).code, "installation_not_linked");
  } finally {
    await app.close();
  }
});

test("kind detection reads a GitLab tree, and a paged tree is never confident", async () => {
  const { client } = fakeGitLab([project(1)]);
  const trees: GitLabClient = {
    ...client,
    getTree: async (_base, projectPath, _ref, page) => {
      if (projectPath === "acme/huge") {
        // Always another page: the bound must stop us and mark it truncated.
        return {
          entries: [{ path: `f${page}/main.tf`, type: "blob" }],
          nextPage: page + 1,
        };
      }
      return {
        entries: [
          { path: "infra", type: "tree" },
          { path: "infra/main.tf", type: "blob" },
        ],
        nextPage: null,
      };
    },
    getFileHead: async () => null,
  };
  const app = await buildApp(oauthEnv(), { gitlab: trees, oauth2Http: offlineOAuth });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  invalidateKindCache();
  try {
    await seedGitLabConnection(app, orgId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/integrations/gitlab/repositories/detect`,
      payload: {
        repositories: [
          { owner: "acme", name: "infra", ref: "main" },
          { owner: "acme", name: "huge", ref: "main" },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { detections } = res.json() as {
      detections: {
        fullName: string;
        kind: string | null;
        confidence: string;
        suggestedPath: string | null;
        truncated: boolean;
      }[];
    };
    const byName = new Map(detections.map((d) => [d.fullName, d]));
    assert.equal(byName.get("acme/infra")!.kind, "terraform");
    assert.equal(byName.get("acme/infra")!.confidence, "high");
    assert.equal(byName.get("acme/infra")!.suggestedPath, "infra");

    const huge = byName.get("acme/huge")!;
    assert.equal(huge.truncated, true, "we stopped before the end, and say so");
    assert.equal(huge.confidence, "low", "a partial tree is never confident");
  } finally {
    await app.close();
  }
});

test("a GitLab project outside the authorizing user's namespace still imports", async () => {
  // The bug this pins: `config.account` for a GitLab OAuth connection is the
  // *user* who authorized (`tintin92350`), not the namespace of the project
  // (`helix-saas`). Matching them refused every group project the user could
  // perfectly well read, with "this repository is private".
  const { client } = fakeGitLab([
    project(1, {
      path_with_namespace: "helix-saas/infra-terraform",
      path: "infra-terraform",
      namespace: { full_path: "helix-saas" },
      http_url_to_repo: "https://gitlab.com/helix-saas/infra-terraform.git",
    }),
  ]);
  const verified: (string | null | undefined)[] = [];
  const app = await buildApp(oauthEnv(), {
    gitlab: client,
    oauth2Http: offlineOAuth,
    verifyConnection: async (source) => {
      verified.push(source.accessToken);
      // A private project is unreadable without a credential — which is what
      // made the old behaviour fail rather than merely mis-authenticate.
      return source.accessToken
        ? { ok: true, defaultBranchFound: true }
        : { ok: false, error: "auth_failed" };
    },
  });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    await seedGitLabConnection(app, orgId);
    const [project] = await app.db
      .insert(projects)
      .values({
        organizationId: orgId,
        name: "Platform",
        slug: `platform-${Date.now()}`,
      })
      .returning({ id: projects.id });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/import`,
      payload: {
        projectId: project!.id,
        items: [
          {
            cloneUrl: "https://gitlab.com/helix-saas/infra-terraform.git",
            kind: "terraform",
          },
        ],
      },
    });
    assert.equal(res.statusCode, 207, res.body);
    const body = res.json() as {
      imported: { url: string }[];
      failed: { error: string }[];
    };
    assert.deepEqual(body.failed, [], "nothing to fail: the connection covers it");
    assert.equal(body.imported.length, 1);
    assert.equal(
      verified.at(-1),
      "gl-access-token",
      "the check ran with the connection's own token, not anonymously",
    );
  } finally {
    await app.close();
  }
});

test("a connection on another instance does not cover this one", async () => {
  const { client } = fakeGitLab([project(1)]);
  const app = await buildApp(oauthEnv(), {
    gitlab: client,
    oauth2Http: offlineOAuth,
    verifyConnection: async (source) =>
      source.accessToken
        ? { ok: true, defaultBranchFound: true }
        : { ok: false, error: "auth_failed" },
  });
  const orgId = await seedOrg(app);
  invalidateDiscoveryCache();
  try {
    // Connected to a self-managed instance; the URL is gitlab.com.
    await seedGitLabConnection(app, orgId, "https://git.acme.internal");
    const [project] = await app.db
      .insert(projects)
      .values({
        organizationId: orgId,
        name: "Platform",
        slug: `platform-other-${Date.now()}`,
      })
      .returning({ id: projects.id });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/import`,
      payload: {
        projectId: project!.id,
        items: [
          { cloneUrl: "https://gitlab.com/acme/infra.git", kind: "terraform" },
        ],
      },
    });
    assert.equal(res.statusCode, 207, res.body);
    const body = res.json() as { imported: unknown[]; failed: unknown[] };
    assert.deepEqual(body.imported, [], "an instance-bound connection stays there");
    assert.equal(body.failed.length, 1);
  } finally {
    await app.close();
  }
});
