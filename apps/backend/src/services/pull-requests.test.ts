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
import { branchOf, closePullRequestsForBranch } from "./pull-requests.js";
import { dispatchGitEvent, pollRepository } from "./ref-poller.js";

const env = loadEnv();
const exec = promisify(execFile);

// --- branchOf: the short-name normalization ----------------------------------

test("branchOf strips a refs/heads/ prefix but leaves a bare name", () => {
  assert.equal(branchOf("refs/heads/feature-x"), "feature-x");
  assert.equal(branchOf("feature-x"), "feature-x");
});

// --- soft-close against a real (mutable) git remote --------------------------

let fixtureDir: string;
let fixtureUrl: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: fixtureDir });
  return stdout.trim();
}

async function makeFixture(): Promise<void> {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-prlife-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["commit", "--allow-empty", "-m", "root"]);
  fixtureUrl = `file://${fixtureDir}`;
}

/** Create `branch` off main with a commit (so the remote lists it). */
async function createBranch(branch: string): Promise<void> {
  await git(["checkout", "-B", branch, "main"]);
  await git(["commit", "--allow-empty", "-m", `work on ${branch}`]);
  await git(["checkout", "main"]);
}

let counter = 0;
async function createRepo(app: FastifyInstance) {
  counter += 1;
  const p = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "P", slug: `prlife-${Date.now()}-${counter}` },
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
  return { projectId, repo: repo as RepositoryRow, token: r.json().webhookToken };
}

function planPayload() {
  return {
    format_version: "1.2",
    resource_changes: [
      {
        address: "aws_s3_bucket.b",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "b",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["create"] },
      },
    ],
  };
}

/** Open (or update) a PR for `branch` by posting a plan through the CI webhook. */
async function openPr(
  app: FastifyInstance,
  repoId: string,
  token: string,
  branch: string,
  prNumber: number,
  commitSha: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/ci/${repoId}`,
    headers: { "x-groundplan-token": token },
    payload: {
      event: "pull_request",
      ref: branch,
      commit_sha: commitSha,
      pr_number: prNumber,
      payload: planPayload(),
    },
  });
}

async function pollAndDispatch(app: FastifyInstance, repo: RepositoryRow) {
  for (const event of await pollRepository(app, repo)) {
    await dispatchGitEvent(app, repo, event);
  }
}

async function getPull(app: FastifyInstance, repoId: string, number: number) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/repositories/${repoId}/pulls/${number}`,
  });
  return res.json() as { state: string; closedAt: string | null; latestSnapshot: unknown };
}

before(async () => {
  await runMigrations(env.databaseUrl);
  await makeFixture();
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("deleting a PR branch closes the PR but keeps its snapshot", async () => {
  const app = await buildApp(env);
  try {
    const { repo, token } = await createRepo(app);
    await createBranch("feat-close");
    await openPr(app, repo.id, token, "feat-close", 5, "sha-5");
    await pollAndDispatch(app, repo); // seed: main + feat-close recorded

    await git(["branch", "-D", "feat-close"]);
    await pollAndDispatch(app, repo); // BranchDeleted -> soft-close

    const pr = await getPull(app, repo.id, 5);
    assert.equal(pr.state, "closed");
    assert.ok(pr.closedAt, "a closed PR records when");
    assert.ok(pr.latestSnapshot, "the PR's diagram stays viewable after closing");
  } finally {
    await app.close();
  }
});

test("a late plan for a just-deleted branch does not reopen the PR", async () => {
  const app = await buildApp(env);
  try {
    const { repo, token } = await createRepo(app);
    await createBranch("feat-late");
    await openPr(app, repo.id, token, "feat-late", 6, "sha-6a");
    await pollAndDispatch(app, repo);
    await git(["branch", "-D", "feat-late"]);
    await pollAndDispatch(app, repo); // closed now

    // A plan that was already in flight when the branch vanished lands late.
    await openPr(app, repo.id, token, "feat-late", 6, "sha-6b");

    const pr = await getPull(app, repo.id, 6);
    assert.equal(pr.state, "closed", "the late plan attaches but never reopens");
  } finally {
    await app.close();
  }
});

test("recreating a branch and pushing a new PR leaves the old closed PR untouched", async () => {
  const app = await buildApp(env);
  try {
    const { repo, token } = await createRepo(app);
    await createBranch("feat-reuse");
    await openPr(app, repo.id, token, "feat-reuse", 7, "sha-7");
    await pollAndDispatch(app, repo);
    await git(["branch", "-D", "feat-reuse"]);
    await pollAndDispatch(app, repo); // PR 7 closed

    // The branch name comes back with a *new* PR. The poller records it first
    // (as it would in the ~60s before CI runs), then the plan lands.
    await createBranch("feat-reuse");
    await pollAndDispatch(app, repo);
    await openPr(app, repo.id, token, "feat-reuse", 8, "sha-8");

    assert.equal((await getPull(app, repo.id, 7)).state, "closed");
    assert.equal((await getPull(app, repo.id, 8)).state, "open");
  } finally {
    await app.close();
  }
});

test("closing is idempotent across multiple ticks", async () => {
  const app = await buildApp(env);
  try {
    const { repo, token } = await createRepo(app);
    await createBranch("feat-idem");
    await openPr(app, repo.id, token, "feat-idem", 9, "sha-9");
    await pollAndDispatch(app, repo);
    await git(["branch", "-D", "feat-idem"]);

    await pollAndDispatch(app, repo);
    const closedAt = (await getPull(app, repo.id, 9)).closedAt;
    // Direct call twice more: never throws, never re-touches a closed PR.
    assert.equal(await closePullRequestsForBranch(app, repo, "feat-idem"), 0);
    assert.equal(await closePullRequestsForBranch(app, repo, "feat-idem"), 0);
    assert.equal((await getPull(app, repo.id, 9)).closedAt, closedAt);
  } finally {
    await app.close();
  }
});

test("the default pulls list is open-only; ?status widens it", async () => {
  const app = await buildApp(env);
  try {
    const { repo, token } = await createRepo(app);
    await createBranch("feat-open");
    await openPr(app, repo.id, token, "feat-open", 10, "sha-10"); // stays open
    await createBranch("feat-gone");
    await openPr(app, repo.id, token, "feat-gone", 11, "sha-11");
    await pollAndDispatch(app, repo);
    await git(["branch", "-D", "feat-gone"]);
    await pollAndDispatch(app, repo); // PR 11 closed

    const numbers = async (query: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/repositories/${repo.id}/pulls${query}`,
      });
      return (res.json() as { number: number }[]).map((p) => p.number).sort();
    };

    assert.deepEqual(await numbers(""), [10]);
    assert.deepEqual(await numbers("?status=closed"), [11]);
    assert.deepEqual(await numbers("?status=all"), [10, 11]);
  } finally {
    await app.close();
  }
});

// A sanity check that the poller state truly gates matching: an unrelated
// deleted branch never closes a PR whose branch is still live.
test("deleting one branch does not close another branch's PR", async () => {
  const app = await buildApp(env);
  try {
    const { repo, token } = await createRepo(app);
    await createBranch("keep");
    await createBranch("drop");
    await openPr(app, repo.id, token, "keep", 12, "sha-12");
    await openPr(app, repo.id, token, "drop", 13, "sha-13");
    await pollAndDispatch(app, repo);
    await git(["branch", "-D", "drop"]);
    await pollAndDispatch(app, repo);

    assert.equal((await getPull(app, repo.id, 12)).state, "open");
    assert.equal((await getPull(app, repo.id, 13)).state, "closed");
  } finally {
    await app.close();
  }
});
