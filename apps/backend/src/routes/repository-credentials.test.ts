import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { repositories } from "../db/schema.js";
import { seedOrg } from "../test-support.js";

const exec = promisify(execFile);
const env = loadEnv();

let fixtureUrl: string;
let fixtureDir: string;

async function makeFixtureRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-cred-fixture-"));
  const git = (args: string[]) => exec("git", args, { cwd: dir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  return dir;
}

before(async () => {
  await runMigrations(env.databaseUrl);
  fixtureDir = await makeFixtureRepo();
  fixtureUrl = `file://${fixtureDir}`;
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

let counter = 0;
async function createProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
) {
  counter += 1;
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "Creds", slug: `creds-${Date.now()}-${counter}` },
  });
  return res.json().id as string;
}

async function createRepo(
  app: Awaited<ReturnType<typeof buildApp>>,
  orgId: string,
  projectId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: fixtureUrl, ...payload },
  });
}

test("create with a PAT stores it encrypted, masks it, and auto-verifies", async () => {
  const app = await buildApp(env); // real verifier against the local fixture
  const orgId = await seedOrg(app);
  const secret = "ghp_secretTokenValue_1234567890";
  try {
    const projectId = await createProject(app, orgId);
    const res = await createRepo(app, orgId, projectId, { accessToken: secret });
    assert.equal(res.statusCode, 201);

    const repo = res.json();
    assert.equal(repo.accessToken, "***", "PAT masked in response");
    assert.equal(repo.connectionStatus, "ok", "auto-verified against fixture");
    assert.ok(repo.verifiedAt);
    assert.ok(!res.body.includes(secret), "response must not contain the token");

    // At rest: the DB column holds ciphertext, not the plaintext token.
    const [raw] = await app.db
      .select({ at: repositories.accessToken })
      .from(repositories)
      .where(eq(repositories.id, repo.id));
    assert.ok(raw?.at, "access_token column should be set");
    assert.notEqual(raw.at, secret, "must not be plaintext");
    assert.equal(app.encryptor.decrypt(raw.at), secret, "decrypts back");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("connection_status is visible in GET /repositories/:id and the list", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const projectId = await createProject(app, orgId);
    const repo = (await createRepo(app, orgId, projectId, {})).json(); // no PAT

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}`,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().connectionStatus, "unverified");
    assert.equal(got.json().accessToken, null);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    });
    assert.equal(list.json()[0].connectionStatus, "unverified");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("POST /repositories/:id/verify verifies against the fixture", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const projectId = await createProject(app, orgId);
    const repo = (await createRepo(app, orgId, projectId, {})).json();

    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/verify`,
    });
    assert.equal(verified.statusCode, 200);
    assert.deepEqual(verified.json(), { ok: true, default_branch_found: true });

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}`,
    });
    assert.equal(got.json().connectionStatus, "ok");
    assert.ok(got.json().verifiedAt);

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("verify returns a structured error for an unreachable repo", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const projectId = await createProject(app, orgId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
      payload: {
        provider: "github",
        url: "file:///tmp/groundplan-nope-does-not-exist",
      },
    });
    const repo = res.json();

    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/verify`,
    });
    assert.equal(verified.json().ok, false);
    assert.ok(
      ["auth_failed", "not_found", "network"].includes(verified.json().error),
    );

    const got = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}`,
    });
    assert.equal(got.json().connectionStatus, "failed");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("PATCH /repositories/:id updates the PAT and re-verifies", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const projectId = await createProject(app, orgId);
    const repo = (await createRepo(app, orgId, projectId, {})).json();
    assert.equal(repo.connectionStatus, "unverified");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}`,
      payload: { accessToken: "new-pat-value-xyz" },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().accessToken, "***");
    assert.equal(patched.json().connectionStatus, "ok");
    assert.ok(!patched.body.includes("new-pat-value-xyz"));

    const [raw] = await app.db
      .select({ at: repositories.accessToken })
      .from(repositories)
      .where(eq(repositories.id, repo.id));
    assert.ok(raw?.at);
    assert.equal(app.encryptor.decrypt(raw.at), "new-pat-value-xyz");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
