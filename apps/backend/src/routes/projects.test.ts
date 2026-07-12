import { test, before } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";

const env = loadEnv();

// Integration tests: they exercise the real HTTP + Postgres path.
// Requires `docker compose up -d` (a reachable DATABASE_URL).
before(async () => {
  await runMigrations(env.databaseUrl);
});

test("happy path: create project -> add repo -> list -> delete (cascades)", async () => {
  const app = await buildApp(env);
  const slug = `test-${Date.now()}`;
  try {
    // Create a project.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Test Project", slug },
    });
    assert.equal(created.statusCode, 201);
    const project = created.json();
    assert.ok(project.id);
    assert.equal(project.name, "Test Project");
    assert.equal(project.slug, slug);
    assert.ok(project.createdAt);

    // Add a repository to it.
    const repoRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/repositories`,
      payload: { provider: "github", url: "https://github.com/acme/repo" },
    });
    assert.equal(repoRes.statusCode, 201);
    const repo = repoRes.json();
    assert.equal(repo.projectId, project.id);
    assert.equal(repo.provider, "github");
    assert.equal(repo.defaultBranch, "main");

    // List repositories for the project.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/repositories`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().length, 1);
    assert.equal(list.json()[0].id, repo.id);

    // Delete the project.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
    });
    assert.equal(del.statusCode, 204);

    // Project is gone.
    const gone = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}`,
    });
    assert.equal(gone.statusCode, 404);

    // Cascade: the repository was deleted with its project.
    const repoGone = await app.inject({
      method: "DELETE",
      url: `/api/v1/repositories/${repo.id}`,
    });
    assert.equal(repoGone.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("repository access_token is write-only and never returned", async () => {
  // Stub the verifier so creating a repo with a PAT stays offline.
  const app = await buildApp(env, {
    verifyConnection: async () => ({ ok: true, defaultBranchFound: true }),
  });
  const slug = `tok-${Date.now()}`;
  const secret = "super-secret-token-abc123";
  try {
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Tok", slug },
    });
    const project = projectRes.json();

    const repoRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/repositories`,
      payload: {
        provider: "github",
        url: "https://github.com/acme/repo",
        accessToken: secret,
      },
    });
    assert.equal(repoRes.statusCode, 201);
    const repo = repoRes.json();
    assert.equal(repo.provider, "github");
    // Masked, never the value (GP-11).
    assert.equal(repo.accessToken, "***", "PAT should be masked, not omitted");
    assert.ok(!repoRes.body.includes(secret), "create response leaked token value");

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/repositories`,
    });
    assert.ok(!listRes.body.includes(secret), "list response leaked token value");
    assert.equal(listRes.json()[0].accessToken, "***", "list should mask the PAT");

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
  } finally {
    await app.close();
  }
});

test("repository provider is auto-detected from the URL when omitted (GP-51)", async () => {
  const app = await buildApp(env);
  const slug = `detect-${Date.now()}`;
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "Detect", slug },
      })
    ).json();

    const cases: Array<{ url: string; expected: string }> = [
      { url: "https://gitlab.com/acme/infra", expected: "gitlab" },
      { url: "https://dev.azure.com/acme/infra/_git/repo", expected: "azure_devops" },
      { url: "https://git.internal.example.com/acme/infra.git", expected: "generic" },
    ];
    for (const { url, expected } of cases) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/repositories`,
        payload: { url },
      });
      assert.equal(res.statusCode, 201, `create failed for ${url}`);
      assert.equal(res.json().provider, expected, `wrong provider for ${url}`);
    }

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
  } finally {
    await app.close();
  }
});

test("an explicit provider overrides URL detection and is stored (GP-51)", async () => {
  const app = await buildApp(env);
  const slug = `override-${Date.now()}`;
  try {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "Override", slug },
      })
    ).json();

    // A self-hosted GitLab URL would detect as `generic`, but the user overrides.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/repositories`,
      payload: { provider: "gitlab", url: "https://gitlab.example.com/acme/infra" },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().provider, "gitlab");

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
  } finally {
    await app.close();
  }
});

test("POST /projects with a duplicate slug returns 409", async () => {
  const app = await buildApp(env);
  const slug = `dup-${Date.now()}`;
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "First", slug },
    });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Second", slug },
    });
    assert.equal(second.statusCode, 409);

    await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${first.json().id}`,
    });
  } finally {
    await app.close();
  }
});

test("POST /projects with an invalid body returns 422 with field messages", async () => {
  const app = await buildApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { slug: "Not A Valid Slug!" }, // missing name, bad slug pattern
    });
    assert.equal(res.statusCode, 422);

    const body = res.json();
    assert.ok(Array.isArray(body.fields));
    const fields = body.fields.map((f: { field: string }) => f.field);
    assert.ok(fields.includes("name"), "expected a 'name' field error");
    assert.ok(fields.includes("slug"), "expected a 'slug' field error");
    for (const f of body.fields) {
      assert.equal(typeof f.message, "string");
    }
  } finally {
    await app.close();
  }
});
