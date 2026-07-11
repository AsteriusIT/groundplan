import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

// Isolate clone temp dirs to this test process so the clone-cleanup assertions
// (which count gp-clone-* in os.tmpdir()) don't race with clones from other
// concurrently-running test files in the shared /tmp.
process.env.TMPDIR = mkdtempSync(path.join(os.tmpdir(), "gp-test-tmp-"));

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { repositories } from "../db/schema.js";
import { generateDocsSnapshot } from "../services/repo-docs.js";

const env = loadEnv();
const exec = promisify(execFile);

let fixtureDir: string;
let fixtureUrl: string;

/** A throwaway local Terraform git repo, so the docs flow needs no network. */
async function makeTfFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-tf-fixture-"));
  const git = (args: string[]) => exec("git", args, { cwd: dir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await fs.writeFile(
    path.join(dir, "main.tf"),
    'resource "aws_s3_bucket" "data" {\n  bucket = "data"\n}\n\nmodule "net" {\n  source = "./modules/net"\n}\n',
  );
  await fs.mkdir(path.join(dir, "modules", "net"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "modules", "net", "net.tf"),
    'resource "aws_vpc" "this" {\n  cidr_block = "10.0.0.0/16"\n}\n',
  );
  // Malformed file → skipped with a warning.
  await fs.writeFile(path.join(dir, "bad.tf"), 'resource "x" "y" {\n');
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  return dir;
}

async function cloneTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("gp-clone-")).sort();
}

let counter = 0;
async function createRepo(app: FastifyInstance): Promise<{ projectId: string; repoId: string }> {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "D", slug: `docs-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: fixtureUrl, defaultBranch: "main" },
  });
  return { projectId, repoId: r.json().id };
}

before(async () => {
  await runMigrations(env.databaseUrl);
  fixtureDir = await makeTfFixture();
  fixtureUrl = `file://${fixtureDir}`;
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("generate documents main; latest returns the graph and warnings", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const before = await cloneTempDirs();

    const gen = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    assert.equal(gen.statusCode, 201);
    assert.ok(gen.json().id);

    // Clone was cleaned up.
    assert.deepEqual(await cloneTempDirs(), before);

    const latest = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/docs/latest`,
    });
    assert.equal(latest.statusCode, 200);
    const snap = latest.json();
    assert.equal(snap.source, "hcl");
    assert.equal(snap.prNumber, null);
    const ids = snap.graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("aws_s3_bucket.data"));
    assert.ok(ids.includes("module.net"));
    assert.ok(ids.includes("module.net.aws_vpc.this"), "recursed into local module");
    // The malformed file produced a warning; the broken resource is absent.
    assert.equal(snap.stats.warnings.length, 1);
    assert.ok(!ids.some((id: string) => id.includes('"y"') || id === "x.y"));

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("regenerate stores a fresh snapshot; latest reflects the newest", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.json().id, second.json().id, "a new snapshot row");

    const latest = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/docs/latest`,
    });
    assert.equal(latest.json().id, second.json().id);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("a second generation while one is running returns 409", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const [repo] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));

    // Start a generation without awaiting — the in-flight lock is acquired
    // synchronously, so the concurrent HTTP request must see it.
    const inFlight = generateDocsSnapshot(app, repo!);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${repoId}/docs/generate`,
    });
    assert.equal(res.statusCode, 409);
    await inFlight;

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});

test("docs endpoints 404 for an unknown repo; latest 404 before generation", async () => {
  const app = await buildApp(env);
  try {
    const { projectId, repoId } = await createRepo(app);
    const missing = "00000000-0000-4000-8000-000000000000";

    const genMissing = await app.inject({
      method: "POST",
      url: `/api/v1/repositories/${missing}/docs/generate`,
    });
    assert.equal(genMissing.statusCode, 404);

    const latestNone = await app.inject({
      method: "GET",
      url: `/api/v1/repositories/${repoId}/docs/latest`,
    });
    assert.equal(latestNone.statusCode, 404);

    await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
  } finally {
    await app.close();
  }
});
