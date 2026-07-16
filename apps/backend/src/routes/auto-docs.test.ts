import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { seedOrg } from "../test-support.js";

const env = loadEnv();
const exec = promisify(execFile);

let fixtureDir: string;
let fixtureUrl: string;
let sha1: string; // only main.tf
let sha2: string; // main.tf + second.tf

/** A two-commit Terraform repo so we can prove the pushed sha is checked out. */
async function makeFixture(): Promise<void> {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-autodocs-"));
  const git = (args: string[]) => exec("git", args, { cwd: fixtureDir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await fs.writeFile(
    path.join(fixtureDir, "main.tf"),
    'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\n',
  );
  await git(["add", "."]);
  await git(["commit", "-m", "first"]);
  sha1 = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await fs.writeFile(
    path.join(fixtureDir, "second.tf"),
    'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n',
  );
  await git(["add", "."]);
  await git(["commit", "-m", "second"]);
  sha2 = (await git(["rev-parse", "HEAD"])).stdout.trim();
  fixtureUrl = `file://${fixtureDir}`;
}

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "A", slug: `autodocs-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: fixtureUrl, defaultBranch: "main" },
  });
  const repo = r.json();
  return { projectId, repoId: repo.id, token: repo.webhookToken };
}

async function push(
  app: FastifyInstance,
  repoId: string,
  token: string,
  body: { ref: string; commit_sha: string },
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repoId}`,
    headers: { "x-groundplan-token": token },
    payload: { event: "push", payload: {}, ...body },
  });
  await app.flushBackgroundTasks();
  return res;
}

async function hclSnapshots(app: FastifyInstance, orgId: string, repoId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?source=hcl`,
  });
  return res.json() as { id: string; commitSha: string; stats: { trigger?: string } }[];
}

before(async () => {
  await runMigrations(env.databaseUrl);
  await makeFixture();
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("a push to main auto-generates a docs snapshot for the pushed sha", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, token } = await createRepo(app, orgId);

    const res = await push(app, repoId, token, {
      ref: "refs/heads/main",
      commit_sha: sha2,
    });
    assert.equal(res.statusCode, 202);

    const latest = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/repositories/${repoId}/docs/latest`,
    });
    assert.equal(latest.statusCode, 200);
    const snap = latest.json();
    assert.equal(snap.source, "hcl");
    assert.equal(snap.commitSha, sha2);
    assert.equal(snap.stats.trigger, "auto");
    const ids = snap.graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("aws_s3_bucket.a") && ids.includes("aws_s3_bucket.b"));

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("duplicate push events for the same sha produce a single snapshot", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, token } = await createRepo(app, orgId);
    await push(app, repoId, token, { ref: "refs/heads/main", commit_sha: sha2 });
    await push(app, repoId, token, { ref: "refs/heads/main", commit_sha: sha2 });

    assert.equal((await hclSnapshots(app, orgId, repoId)).length, 1);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("the pushed sha is checked out, not just the branch tip", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, token } = await createRepo(app, orgId);
    // Push the OLDER commit — its snapshot must not contain second.tf.
    await push(app, repoId, token, { ref: "refs/heads/main", commit_sha: sha1 });

    const snaps = await hclSnapshots(app, orgId, repoId);
    const forSha1 = snaps.find((s) => s.commitSha === sha1);
    assert.ok(forSha1, "a snapshot for the older sha should exist");

    const full = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${forSha1!.id}`,
    });
    const ids = full.json().graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("aws_s3_bucket.a"));
    assert.ok(!ids.includes("aws_s3_bucket.b"), "second.tf must not be present at sha1");

    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a push to a non-default branch does nothing", async () => {
  const app = await buildApp(env);
  const orgId = await seedOrg(app);
  try {
    const { projectId, repoId, token } = await createRepo(app, orgId);
    await push(app, repoId, token, {
      ref: "refs/heads/feature",
      commit_sha: sha2,
    });
    assert.equal((await hclSnapshots(app, orgId, repoId)).length, 0);
    await app.inject({ method: "DELETE", url: `/api/v1/orgs/${orgId}/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
