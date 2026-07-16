import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { repositories, type RepositoryRow } from "../db/schema.js";
import { seedOrg } from "../test-support.js";
import { dispatchGitEvent, pollRepository } from "./ref-poller.js";
import { regenerateDocsForSha } from "./repo-docs.js";

const env = loadEnv();
const exec = promisify(execFile);

let fixtureDir: string;
let fixtureUrl: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: fixtureDir });
  return stdout.trim();
}

async function makeFixture(): Promise<void> {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-refdocs-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await fs.writeFile(
    path.join(fixtureDir, "main.tf"),
    'resource "aws_s3_bucket" "a" {\n  bucket = "a"\n}\n',
  );
  await git(["add", "."]);
  await git(["commit", "-m", "first"]);
  fixtureUrl = `file://${fixtureDir}`;
}

/** Add a second bucket to main and return the new tip sha. */
async function advanceMain(): Promise<string> {
  await git(["checkout", "main"]);
  await fs.writeFile(
    path.join(fixtureDir, "second.tf"),
    'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n',
  );
  await git(["add", "."]);
  await git(["commit", "-m", "second"]);
  return git(["rev-parse", "HEAD"]);
}

let counter = 0;
async function createRepo(app: FastifyInstance, orgId: string): Promise<RepositoryRow> {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects`,
    payload: { name: "A", slug: `refdocs-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/projects/${projectId}/repositories`,
    payload: { provider: "github", url: fixtureUrl, defaultBranch: "main" },
  });
  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, r.json().id));
  return repo as RepositoryRow;
}

/** The poller path, scoped to one repo (never the whole shared test DB). */
async function pollAndDispatch(app: FastifyInstance, repo: RepositoryRow) {
  for (const event of await pollRepository(app, repo)) {
    await dispatchGitEvent(app, repo, event);
  }
}

async function hclSnapshots(app: FastifyInstance, orgId: string, repoId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/repositories/${repoId}/snapshots?source=hcl`,
  });
  return res.json() as {
    id: string;
    commitSha: string;
    stats: { trigger?: string };
  }[];
}

before(async () => {
  await runMigrations(env.databaseUrl);
  await makeFixture();
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("a MainUpdated from the poller regenerates docs for the new sha", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const repo = await createRepo(app, orgId);
    await pollAndDispatch(app, repo); // seed: main is new, no event, no docs
    assert.equal((await hclSnapshots(app, orgId, repo.id)).length, 0);

    const newSha = await advanceMain();
    await pollAndDispatch(app, repo); // main moved -> MainUpdated -> docs

    const snaps = await hclSnapshots(app, orgId, repo.id);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]!.commitSha, newSha);
    assert.equal(snaps[0]!.stats.trigger, "auto");

    const full = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/snapshots/${snaps[0]!.id}`,
    });
    const ids = full.json().graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("aws_s3_bucket.a") && ids.includes("aws_s3_bucket.b"));
  } finally {
    await app.close();
  }
});

test("two MainUpdated for the same sha produce exactly one snapshot", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const repo = await createRepo(app, orgId);
    const sha = await git(["rev-parse", "HEAD"]);

    await regenerateDocsForSha(app, repo, sha);
    await regenerateDocsForSha(app, repo, sha); // idempotent by sha

    assert.equal((await hclSnapshots(app, orgId, repo.id)).length, 1);
  } finally {
    await app.close();
  }
});

test("manual regeneration coexists with the poller's auto snapshots", async () => {
  const app = await buildApp(env);
  try {
    const orgId = await seedOrg(app);
    const repo = await createRepo(app, orgId);
    const sha = await git(["rev-parse", "HEAD"]);
    await regenerateDocsForSha(app, repo, sha); // auto (poller)

    // The manual "regenerate" button hits the same route; it still works and
    // adds its own snapshot rather than being blocked by the auto one.
    const manual = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/repositories/${repo.id}/docs/generate`,
    });
    assert.equal(manual.statusCode, 201);

    const snaps = await hclSnapshots(app, orgId, repo.id);
    assert.equal(snaps.length, 2);
    const triggers = snaps.map((s) => s.stats.trigger).sort();
    assert.deepEqual(triggers, ["auto", "manual"]);
  } finally {
    await app.close();
  }
});
