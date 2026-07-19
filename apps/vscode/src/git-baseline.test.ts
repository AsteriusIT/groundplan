/**
 * GP-152: the baseline provider against real throwaway git repositories — no
 * `vscode` import, no mocks of git itself. Each test builds a repo in a temp
 * dir, so the provider is exercised exactly as the extension host runs it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BaselineProvider,
  runGit,
  watchGitChanges,
  type GitRunner,
} from "./git-baseline";

function g(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

const repos: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-baseline-"));
  repos.push(dir);
  return dir;
}
function makeRepo(): string {
  const dir = makeDir();
  g(dir, "init", "-b", "main");
  return dir;
}
test.after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

const MAIN_TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "one"\n}\n';

test("head mode returns the exact committed file set; the working tree does not leak in", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  writeFileSync(join(dir, "readme.md"), "not terraform");
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  // Uncommitted noise: an edit, a new file, a deletion candidate.
  writeFileSync(join(dir, "main.tf"), MAIN_TF.replace("one", "dirty"));
  writeFileSync(join(dir, "new.tf"), 'resource "aws_sqs_queue" "q" {}\n');

  const provider = new BaselineProvider(dir);
  const result = await provider.get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.ref, "HEAD");
  assert.deepEqual(
    result.baseline.files.map((f) => f.path),
    ["main.tf"],
  );
  assert.equal(result.baseline.files[0]?.content, MAIN_TF);
  // The parsed snapshot is part of the baseline (parse once, diff many).
  assert.ok(result.baseline.snapshot.nodes.some((n) => n.id === "aws_s3_bucket.b"));
});

test("merge-base mode diffs against the fork point, preferring origin/main", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "base");
  const baseSha = g(dir, "rev-parse", "HEAD");

  g(dir, "checkout", "-b", "feature");
  writeFileSync(join(dir, "extra.tf"), 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "feature work");

  // No remote configured: falls back to the local main branch.
  const provider = new BaselineProvider(dir);
  const viaMain = await provider.get("merge-base");
  assert.ok(viaMain.ok, !viaMain.ok ? viaMain.reason : "");
  assert.equal(viaMain.baseline.ref, "merge-base main");
  assert.equal(viaMain.baseline.sha, baseSha);
  assert.deepEqual(
    viaMain.baseline.files.map((f) => f.path),
    ["main.tf"],
  );

  // A fabricated origin/main ref wins over the local branch.
  g(dir, "update-ref", "refs/remotes/origin/main", baseSha);
  const fresh = new BaselineProvider(dir);
  const viaOrigin = await fresh.get("merge-base");
  assert.ok(viaOrigin.ok, !viaOrigin.ok ? viaOrigin.reason : "");
  assert.equal(viaOrigin.baseline.ref, "merge-base origin/main");
});

test("a new commit moves the baseline after invalidate()", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const provider = new BaselineProvider(dir);
  const first = await provider.get("head");
  assert.ok(first.ok);

  writeFileSync(join(dir, "main.tf"), MAIN_TF.replace("one", "two"));
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "two");
  provider.invalidate();

  const second = await provider.get("head");
  assert.ok(second.ok);
  assert.notEqual(second.baseline.sha, first.ok ? first.baseline.sha : "");
  assert.match(second.baseline.files[0]?.content ?? "", /two/);
});

test("a cached baseline runs no git at all; a re-resolved same sha reparses nothing", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let calls = 0;
  const counted: GitRunner = (args, cwd) => {
    calls++;
    return runGit(args, cwd);
  };
  const provider = new BaselineProvider(dir, counted);

  await provider.get("head");
  const afterFirst = calls;
  await provider.get("head");
  assert.equal(calls, afterFirst, "a warm get() must not shell out (typing path)");

  // Same HEAD re-resolved after invalidate: one rev-parse, no ls-tree/show.
  provider.invalidate();
  await provider.get("head");
  assert.equal(calls, afterFirst + 1);
});

test("non-git folders, empty repos and missing main report a graceful reason", async () => {
  const notGit = makeDir();
  const noRepo = await new BaselineProvider(notGit).get("head");
  assert.ok(!noRepo.ok && /not a git repository/i.test(noRepo.reason));

  const empty = makeRepo();
  const noCommits = await new BaselineProvider(empty).get("head");
  assert.ok(!noCommits.ok && /no commit/i.test(noCommits.reason));

  const noMain = makeRepo();
  writeFileSync(join(noMain, "main.tf"), MAIN_TF);
  g(noMain, "add", "-A");
  g(noMain, "commit", "-m", "one");
  g(noMain, "branch", "-m", "trunk");
  const noBase = await new BaselineProvider(noMain).get("merge-base");
  assert.ok(!noBase.ok && /main/.test(noBase.reason));
});

test("vendored directories are excluded, matching the live view's glob", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  mkdirSync(join(dir, ".terraform", "modules", "x"), { recursive: true });
  writeFileSync(join(dir, ".terraform", "modules", "x", "vendored.tf"), "resource \"a_b\" \"c\" {}\n");
  mkdirSync(join(dir, "modules"));
  writeFileSync(join(dir, "modules", "net.tf"), 'resource "aws_vpc" "v" {}\n');
  g(dir, "add", "-A", "-f");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(dir).get("head");
  assert.ok(result.ok);
  assert.deepEqual(
    result.baseline.files.map((f) => f.path).sort(),
    ["main.tf", "modules/net.tf"],
  );
});

test("watchGitChanges fires on a commit and stays quiet for worktree edits", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let fired = 0;
  const watcher = watchGitChanges(dir, () => fired++, 50);
  try {
    assert.ok(watcher, "a git repo must be watchable");
    // A plain worktree edit never touches .git refs.
    writeFileSync(join(dir, "main.tf"), MAIN_TF.replace("one", "editing"));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fired, 0);

    g(dir, "add", "-A");
    g(dir, "commit", "-m", "two");
    const deadline = Date.now() + 2000;
    while (fired === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(fired > 0, "a commit must trigger the watcher");
  } finally {
    watcher?.dispose();
  }
});

test("watchGitChanges on a non-git folder is null, not an error", () => {
  assert.equal(watchGitChanges(makeDir(), () => {}, 50), null);
});

test("a workspace folder below the repo root gets folder-relative paths", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "envs", "prod"), { recursive: true });
  writeFileSync(join(dir, "envs", "prod", "main.tf"), MAIN_TF);
  writeFileSync(join(dir, "elsewhere.tf"), 'resource "aws_vpc" "v" {}\n');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(join(dir, "envs", "prod")).get("head");
  assert.ok(result.ok);
  assert.deepEqual(
    result.baseline.files.map((f) => f.path),
    ["main.tf"],
  );
});
