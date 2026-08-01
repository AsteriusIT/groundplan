/**
 * GP-152: the baseline provider against real throwaway git repositories — no
 * `vscode` import, no mocks of git itself. Each test builds a repo in a temp
 * dir, so the provider is exercised exactly as the extension host runs it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BaselineProvider,
  findGitRoot,
  parseLsTreeEntry,
  runGit,
  runGitBatch,
  splitBatch,
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

test("the default branch is detected, not assumed to be main", async () => {
  // A repository whose trunk is `master` — the case that used to report
  // "no origin/main or main branch to compare against" and offer no way out.
  const dir = makeDir();
  g(dir, "init", "-b", "master");
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "base");
  const baseSha = g(dir, "rev-parse", "HEAD");

  g(dir, "checkout", "-b", "feature");
  writeFileSync(join(dir, "extra.tf"), 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "feature work");

  const provider = new BaselineProvider(dir);
  assert.equal(await provider.defaultBranch(), "master");
  const result = await provider.get("merge-base");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.ref, "merge-base master");
  assert.equal(result.baseline.sha, baseSha);
});

test("origin/HEAD is believed over the candidate list", async () => {
  // Both `main` and `master` exist; only origin/HEAD says which is the trunk.
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "base");
  const baseSha = g(dir, "rev-parse", "HEAD");
  g(dir, "branch", "master");
  g(dir, "update-ref", "refs/remotes/origin/master", baseSha);
  g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");

  const provider = new BaselineProvider(dir);
  assert.equal(await provider.defaultBranch(), "origin/master");
  const result = await provider.get("merge-base");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.ref, "merge-base origin/master");
});

test("an origin/HEAD left pointing at a deleted branch falls through, not over", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "base");
  // origin/HEAD outlives the branch it names — the remote renamed its trunk
  // and nobody ran `git remote set-head`.
  g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone");

  const provider = new BaselineProvider(dir);
  assert.equal(await provider.defaultBranch(), "main");
  const result = await provider.get("merge-base");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.ref, "merge-base main");
});

test("a repository with no recognisable trunk says so, and stays usable", async () => {
  const dir = makeDir();
  g(dir, "init", "-b", "develop");
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const provider = new BaselineProvider(dir);
  assert.equal(await provider.defaultBranch(), null);
  const result = await provider.get("merge-base");
  assert.ok(!result.ok);
  assert.match(result.reason, /no default branch/i);
  // The named-branch route still works — that is the way out.
  const named = await provider.get("branch:refs/heads/develop");
  assert.ok(named.ok, !named.ok ? named.reason : "");
});

test("a named branch is the fork point with that branch", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "base");
  const baseSha = g(dir, "rev-parse", "HEAD");

  g(dir, "checkout", "-b", "release/2.4");
  writeFileSync(join(dir, "rel.tf"), 'resource "aws_vpc" "r" {}\n');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "release work");

  g(dir, "checkout", "main");
  writeFileSync(join(dir, "extra.tf"), 'resource "aws_sqs_queue" "q" {}\n');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "main moves on");

  const result = await new BaselineProvider(dir).get("branch:refs/heads/release/2.4");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  // The fork point, not the branch tip: a colleague's push must not turn up
  // in the reader's diff as work they have to undo.
  assert.equal(result.baseline.sha, baseSha);
  assert.equal(result.baseline.ref, "merge-base release/2.4");
  assert.deepEqual(result.baseline.files.map((f) => f.path), ["main.tf"]);
});

test("a branch that is not there is named in the reason, and the choice is kept", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const provider = new BaselineProvider(dir);
  const missing = await provider.get("branch:refs/remotes/origin/release/2.4");
  assert.ok(!missing.ok);
  assert.match(missing.reason, /not found/);
  assert.match(missing.reason, /origin\/release\/2\.4/);

  // It heals by itself once the ref arrives (a fetch, then the ref watcher).
  g(dir, "update-ref", "refs/remotes/origin/release/2.4", g(dir, "rev-parse", "HEAD"));
  provider.invalidate();
  const found = await provider.get("branch:refs/remotes/origin/release/2.4");
  assert.ok(found.ok, !found.ok ? found.reason : "");
});

test("unrelated histories are told apart from a missing branch", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  g(dir, "checkout", "--orphan", "imported");
  writeFileSync(join(dir, "other.tf"), 'resource "aws_vpc" "v" {}\n');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "unrelated");

  const result = await new BaselineProvider(dir).get("branch:refs/heads/main");
  assert.ok(!result.ok);
  assert.match(result.reason, /no common commit/i);
  assert.match(result.reason, /main/);
});

test("a warm merge-base get() shells out no more than a warm head one", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let calls = 0;
  const counted: GitRunner = (args, cwd) => {
    calls++;
    return runGit(args, cwd);
  };
  const provider = new BaselineProvider(dir, counted, undefined, undefined, (shas, cwd) => {
    calls++;
    return runGitBatch(shas, cwd);
  });

  await provider.get("merge-base");
  const afterFirst = calls;
  await provider.get("merge-base");
  // The detected default branch is memoised with the resolution: typing must
  // not re-detect it any more than it re-resolves the sha.
  assert.equal(calls, afterFirst, "a warm get() must not shell out (typing path)");
  await provider.defaultBranch();
  assert.equal(calls, afterFirst, "the panel asking for the name must not either");
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
  const provider = new BaselineProvider(dir, counted, undefined, undefined, (shas, cwd) => {
    calls++;
    return runGitBatch(shas, cwd);
  });

  await provider.get("head");
  const afterFirst = calls;
  await provider.get("head");
  assert.equal(calls, afterFirst, "a warm get() must not shell out (typing path)");

  // Same HEAD re-resolved after invalidate: one rev-parse, no ls-tree/show.
  provider.invalidate();
  await provider.get("head");
  assert.equal(calls, afterFirst + 1);
});

// A repository with no recognisable trunk is covered by "a repository with no
// recognisable trunk says so, and stays usable", which also asserts the way
// out; `trunk` itself is now one of the detected candidates.
test("non-git folders and empty repos report a graceful reason", async () => {
  const notGit = makeDir();
  const noRepo = await new BaselineProvider(notGit).get("head");
  assert.ok(!noRepo.ok && /not a git repository/i.test(noRepo.reason));

  const empty = makeRepo();
  const noCommits = await new BaselineProvider(empty).get("head");
  assert.ok(!noCommits.ok && /no commit/i.test(noCommits.reason));
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

test("a stack below the folder root still parses into the baseline snapshot", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "infra"));
  writeFileSync(join(dir, "infra", "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(dir).get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.snapshot.nodes.length, 1);
});

test("reset() re-parses under a moved root; the sha cache alone holds it", async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "infra"));
  writeFileSync(join(dir, "infra", "main.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let root = "infra";
  const provider = new BaselineProvider(dir, undefined, undefined, () => root);
  const first = await provider.get("head");
  assert.ok(first.ok, !first.ok ? first.reason : "");
  assert.equal(first.baseline.snapshot.nodes.length, 1);

  // The setting moved, but a sha's cached parse is only dropped by reset().
  root = "elsewhere";
  const cached = await provider.get("head");
  assert.ok(cached.ok && cached.baseline.snapshot.nodes.length === 1);

  provider.reset();
  const reparsed = await provider.get("head");
  assert.ok(reparsed.ok, !reparsed.ok ? reparsed.reason : "");
  assert.equal(reparsed.baseline.snapshot.nodes.length, 0);
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

test("findGitRoot walks up from a subfolder; null outside any repo", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, "envs", "prod"), { recursive: true });
  assert.equal(findGitRoot(join(dir, "envs", "prod")), dir);
  assert.equal(findGitRoot(dir), dir);
  assert.equal(findGitRoot(makeDir()), null);
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

test("splitBatch frames on bytes, so multi-byte content cannot shift the next file", () => {
  // "é" is two bytes and one character: a character-based split loses a byte
  // per accent and every following object lands askew.
  const first = Buffer.from('resource "a" "é" {}\n', "utf8");
  const second = Buffer.from('resource "b" "c" {}\n', "utf8");
  const out = Buffer.concat([
    Buffer.from(`aaa blob ${first.length}\n`, "utf8"),
    first,
    Buffer.from("\n", "utf8"),
    Buffer.from(`bbb blob ${second.length}\n`, "utf8"),
    second,
    Buffer.from("\n", "utf8"),
  ]);

  const objects = splitBatch(out, 2);
  assert.equal(objects.length, 2);
  assert.equal(objects[0]?.toString("utf8"), first.toString("utf8"));
  assert.equal(objects[1]?.toString("utf8"), second.toString("utf8"));
});

test("splitBatch refuses a missing object rather than returning nonsense", () => {
  const out = Buffer.from("deadbeef missing\n", "utf8");
  assert.throws(() => splitBatch(out, 1), /missing/);
});

test("parseLsTreeEntry reads mode/type/sha/path, including paths with spaces", () => {
  assert.deepEqual(parseLsTreeEntry("100644 blob abc123\tenvs/my stack/main.tf"), {
    mode: "100644",
    type: "blob",
    sha: "abc123",
    path: "envs/my stack/main.tf",
  });
  assert.equal(parseLsTreeEntry("not a tree record"), null);
});

test("baseline content survives non-ASCII and CRLF byte-for-byte", async () => {
  const dir = makeRepo();
  // Two files: the first is multi-byte, so a character-based split would
  // corrupt the second.
  writeFileSync(join(dir, "a.tf"), 'resource "aws_s3_bucket" "é" {\r\n  bucket = "café"\r\n}\r\n');
  writeFileSync(join(dir, "b.tf"), MAIN_TF);
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(dir).get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.deepEqual(result.baseline.files.map((f) => f.path), ["a.tf", "b.tf"]);
  assert.equal(
    result.baseline.files[0]?.content,
    'resource "aws_s3_bucket" "é" {\r\n  bucket = "café"\r\n}\r\n',
  );
  assert.equal(result.baseline.files[1]?.content, MAIN_TF);
});

test("reading a baseline spawns two git processes, not one per file", async () => {
  const dir = makeRepo();
  const expected = new Map<string, string>();
  for (const name of ["a.tf", "b.tf", "c.tf", "d.tf", "e.tf"]) {
    const content = MAIN_TF.replace('"b"', `"${name[0]}"`);
    writeFileSync(join(dir, name), content);
    expected.set(name, content);
  }
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let plain = 0;
  let batches = 0;
  const provider = new BaselineProvider(
    dir,
    (args, cwd) => {
      plain++;
      return runGit(args, cwd);
    },
    undefined,
    undefined,
    (shas, cwd) => {
      batches++;
      return runGitBatch(shas, cwd);
    },
  );

  const result = await provider.get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.equal(result.baseline.files.length, 5);
  // rev-parse --show-toplevel, rev-parse HEAD, ls-tree — and one batch.
  assert.equal(plain, 3);
  assert.equal(batches, 1, "one cat-file --batch, whatever the file count");
  // Each path must get back its own content, not a neighbour's: cat-file
  // --batch answers strictly in stdin request order, and a shuffled zip
  // between entries and contents would pass the count assertions above
  // while silently swapping files.
  for (const file of result.baseline.files) {
    assert.equal(file.content, expected.get(file.path));
  }
});

test("a zero-byte file and one with no trailing newline survive the batch path", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "empty.tf"), "");
  writeFileSync(join(dir, "no-newline.tf"), 'resource "aws_vpc" "v" {}');
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(dir).get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  const byPath = new Map(result.baseline.files.map((f) => [f.path, f.content]));
  assert.equal(byPath.get("empty.tf"), "");
  assert.equal(byPath.get("no-newline.tf"), 'resource "aws_vpc" "v" {}');
});

test("a symlinked .tf is excluded — its blob content is a link target, never HCL", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "main.tf"), MAIN_TF);
  symlinkSync("main.tf", join(dir, "linked.tf"));
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  const result = await new BaselineProvider(dir).get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.deepEqual(result.baseline.files.map((f) => f.path), ["main.tf"]);
});

test("an empty baseline runs no batch at all", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "readme.md"), "no terraform here");
  g(dir, "add", "-A");
  g(dir, "commit", "-m", "one");

  let batches = 0;
  const provider = new BaselineProvider(dir, undefined, undefined, undefined, (shas, cwd) => {
    batches++;
    return runGitBatch(shas, cwd);
  });
  const result = await provider.get("head");
  assert.ok(result.ok, !result.ok ? result.reason : "");
  assert.deepEqual(result.baseline.files, []);
  assert.equal(batches, 0);
});
