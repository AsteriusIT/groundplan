/**
 * The branch list behind the diff picker. Same posture as `git-baseline`: no
 * `vscode` import, real throwaway repositories, no mock of git itself — the
 * `showQuickPick` call that consumes this is the only part left in
 * `extension.ts`, and it is the part with nothing to decide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listBranches, parseBranchRefs } from "./branches";
import { runGit } from "./git-baseline";

const repos: string[] = [];
function g(cwd: string, args: string[], when?: string): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      // Committer date drives the sort; leaving it to the clock makes the
      // ordering assertions a coin toss between commits in the same second.
      env: when ? { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } : process.env,
    },
  ).trim();
}
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-branches-"));
  repos.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

const TAB = "\t";

test("parseBranchRefs reads the ref, the reader's name for it, and its age", () => {
  const out = [
    `refs/heads/main${TAB}2 hours ago`,
    `refs/remotes/origin/release/2.4${TAB}3 days ago`,
    "",
  ].join("\n");

  assert.deepEqual(parseBranchRefs(out), [
    { ref: "refs/heads/main", name: "main", when: "2 hours ago" },
    {
      ref: "refs/remotes/origin/release/2.4",
      name: "origin/release/2.4",
      when: "3 days ago",
    },
  ]);
});

test("parseBranchRefs drops the remote's HEAD, which is a pointer, not a branch", () => {
  const out = [
    `refs/remotes/origin/HEAD${TAB}2 hours ago`,
    `refs/heads/main${TAB}2 hours ago`,
  ].join("\n");

  assert.deepEqual(
    parseBranchRefs(out).map((b) => b.ref),
    ["refs/heads/main"],
  );
});

test("parseBranchRefs skips records it cannot read rather than inventing fields", () => {
  const out = [
    "no-tab-here",
    `${TAB}2 hours ago`,
    `refs/heads/ok${TAB}now`,
    // A ref this extension would refuse to hand to git has no business being
    // offered as a choice.
    `refs/heads/a b${TAB}now`,
  ].join("\n");

  assert.deepEqual(
    parseBranchRefs(out).map((b) => b.ref),
    ["refs/heads/ok"],
  );
});

test("listBranches returns local and remote-tracking branches, newest first", async () => {
  const dir = makeDir();
  g(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "a");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-m", "old"], "2020-01-01T00:00:00Z");
  const oldSha = g(dir, ["rev-parse", "HEAD"]);
  g(dir, ["update-ref", "refs/remotes/origin/main", oldSha]);
  g(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  g(dir, ["checkout", "-b", "release/2.4"]);
  writeFileSync(join(dir, "b.txt"), "b");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-m", "new"], "2024-06-01T00:00:00Z");

  const branches = await listBranches(runGit, dir);

  assert.deepEqual(
    branches.map((b) => b.name),
    ["release/2.4", "main", "origin/main"],
  );
  assert.equal(branches[0]?.ref, "refs/heads/release/2.4");
  assert.ok(branches[0]?.when, "each entry dates itself for the picker");
});

test("a git failure reaches the caller, so the picker can say so", async () => {
  // An empty list and a broken repository must not look the same: one offers
  // nothing to pick, the other has to be reported.
  await assert.rejects(() => listBranches(runGit, makeDir()));
});
