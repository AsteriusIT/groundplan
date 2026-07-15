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
import { remoteRefs, repositories, type RepositoryRow } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { diffRefs, pollRepository } from "./ref-poller.js";

const env = loadEnv();
const exec = promisify(execFile);

// --- diffRefs: the whole decision procedure, no git required ------------------

test("a new branch appearing emits no actionable event", () => {
  const events = diffRefs(new Map(), new Map([["main", "aaa"]]), "main");
  assert.deepEqual(events, []);
});

test("the default branch moving is MainUpdated", () => {
  const events = diffRefs(
    new Map([["main", "aaa"]]),
    new Map([["main", "bbb"]]),
    "main",
  );
  assert.deepEqual(events, [{ type: "MainUpdated", branch: "main", sha: "bbb" }]);
});

test("a non-default branch moving is BranchUpdated", () => {
  const events = diffRefs(
    new Map([["feature", "aaa"]]),
    new Map([["feature", "bbb"]]),
    "main",
  );
  assert.deepEqual(events, [{ type: "BranchUpdated", branch: "feature", sha: "bbb" }]);
});

test("a branch disappearing is BranchDeleted with its last sha", () => {
  const events = diffRefs(
    new Map([["main", "aaa"], ["feature", "ccc"]]),
    new Map([["main", "aaa"]]),
    "main",
  );
  assert.deepEqual(events, [{ type: "BranchDeleted", branch: "feature", sha: "ccc" }]);
});

test("an unchanged remote emits nothing", () => {
  const refs = new Map([["main", "aaa"], ["feature", "bbb"]]);
  assert.deepEqual(diffRefs(refs, new Map(refs), "main"), []);
});

// --- pollRepository: end to end against a real (mutable) git remote ----------

let fixtureDir: string;
let fixtureUrl: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: fixtureDir });
  return stdout.trim();
}

async function shaOf(ref: string): Promise<string> {
  return git(["rev-parse", ref]);
}

/** Commit an empty change on `branch` (creating it if needed) and return its sha. */
async function commitOn(branch: string, message: string): Promise<string> {
  await git(["checkout", "-B", branch]);
  await git(["commit", "--allow-empty", "-m", message]);
  return shaOf("HEAD");
}

async function makeFixture(): Promise<void> {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-refpoll-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["commit", "--allow-empty", "-m", "root"]);
  fixtureUrl = `file://${fixtureDir}`;
}

let counter = 0;
async function createRepo(app: FastifyInstance): Promise<RepositoryRow> {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "A", slug: `refpoll-${Date.now()}-${counter}` },
  });
  const projectId = p.json().id;
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/repositories`,
    payload: { provider: "github", url: fixtureUrl, defaultBranch: "main" },
  });
  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, r.json().id));
  return repo as RepositoryRow;
}

async function storedRefs(app: FastifyInstance, repoId: string) {
  const rows = await app.db
    .select({ refName: remoteRefs.refName, sha: remoteRefs.sha })
    .from(remoteRefs)
    .where(eq(remoteRefs.repositoryId, repoId));
  return new Map(rows.map((r) => [r.refName, r.sha]));
}

before(async () => {
  await runMigrations(env.databaseUrl);
  await makeFixture();
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("the first poll seeds ref state and emits nothing", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    const events = await pollRepository(app, repo);
    assert.deepEqual(events, []);
    const stored = await storedRefs(app, repo.id);
    assert.equal(stored.get("main"), await shaOf("main"));
  } finally {
    await app.close();
  }
});

test("a moved main emits MainUpdated within one poll", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    await pollRepository(app, repo); // seed
    await git(["checkout", "main"]);
    const newSha = await commitOn("main", "move main");

    const events = await pollRepository(app, repo);
    assert.deepEqual(events, [{ type: "MainUpdated", branch: "main", sha: newSha }]);
    assert.equal((await storedRefs(app, repo.id)).get("main"), newSha);
  } finally {
    await app.close();
  }
});

test("a moved feature branch emits BranchUpdated, not MainUpdated", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    await commitOn("feature-a", "start feature"); // exists before we seed
    await git(["checkout", "main"]);
    await pollRepository(app, repo); // seed (feature-a is now known)

    const moved = await commitOn("feature-a", "advance feature");
    await git(["checkout", "main"]);
    const events = await pollRepository(app, repo);
    assert.deepEqual(events, [
      { type: "BranchUpdated", branch: "feature-a", sha: moved },
    ]);
  } finally {
    await app.close();
  }
});

test("a deleted branch emits BranchDeleted exactly once", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    await commitOn("feature-b", "start");
    const lastSha = await shaOf("feature-b");
    await git(["checkout", "main"]);
    await pollRepository(app, repo); // seed with feature-b present

    await git(["branch", "-D", "feature-b"]);
    const first = await pollRepository(app, repo);
    assert.deepEqual(first, [
      { type: "BranchDeleted", branch: "feature-b", sha: lastSha },
    ]);

    // The branch is now gone from stored state, so the next tick is silent.
    const second = await pollRepository(app, repo);
    assert.deepEqual(second, []);
    assert.equal((await storedRefs(app, repo.id)).has("feature-b"), false);
  } finally {
    await app.close();
  }
});

test("a new branch is recorded but triggers no event", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    await pollRepository(app, repo); // seed (just main)

    const newSha = await commitOn("feature-c", "new branch");
    await git(["checkout", "main"]);
    const events = await pollRepository(app, repo);
    assert.deepEqual(events, []);
    assert.equal((await storedRefs(app, repo.id)).get("feature-c"), newSha);
  } finally {
    await app.close();
  }
});

test("a second poll with no remote change replays no events (restart-safe)", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    await pollRepository(app, repo);
    assert.deepEqual(await pollRepository(app, repo), []);
  } finally {
    await app.close();
  }
});

test("an ls-remote failure emits nothing and leaves stored refs untouched", async () => {
  const app = await buildApp(env);
  try {
    const repo = await createRepo(app);
    await pollRepository(app, repo); // seed real state
    const before = await storedRefs(app, repo.id);

    // Point the repo at an unreachable remote and poll: no events, no mutation.
    const broken: RepositoryRow = { ...repo, url: "file:///nonexistent/gp-missing" };
    const events = await pollRepository(app, broken);
    assert.deepEqual(events, []);

    const after = await storedRefs(app, repo.id);
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
    const [row] = await app.db
      .select({ pollError: repositories.pollError })
      .from(repositories)
      .where(eq(repositories.id, repo.id));
    assert.ok(row?.pollError, "a failed poll records its error");
  } finally {
    await app.close();
  }
});
