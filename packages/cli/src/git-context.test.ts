import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectBranch,
  detectGitContext,
  detectPrNumber,
  detectSha,
  type Env,
  type GitRunner,
} from "./git-context.js";

const noGit: GitRunner = () => null;

test("a PR's source branch (GITHUB_HEAD_REF) beats the merge ref", () => {
  const env: Env = { GITHUB_HEAD_REF: "feature-x", GITHUB_REF_NAME: "5/merge" };
  assert.equal(detectBranch(env, noGit), "feature-x");
});

test("a push uses GITHUB_REF_NAME when there is no head ref", () => {
  assert.equal(detectBranch({ GITHUB_REF_NAME: "main" }, noGit), "main");
});

test("GitLab and Azure branch vars are recognised", () => {
  assert.equal(
    detectBranch({ CI_COMMIT_REF_NAME: "gl-branch" }, noGit),
    "gl-branch",
  );
  assert.equal(
    detectBranch({ BUILD_SOURCEBRANCHNAME: "az-branch" }, noGit),
    "az-branch",
  );
});

test("with no env, the branch falls back to git — but detached HEAD is null", () => {
  assert.equal(detectBranch({}, () => "on-disk-branch"), "on-disk-branch");
  assert.equal(detectBranch({}, () => "HEAD"), null);
  assert.equal(detectBranch({}, noGit), null);
});

test("the sha comes from CI env first, then git", () => {
  assert.equal(detectSha({ GITHUB_SHA: "abc123" }, noGit), "abc123");
  assert.equal(detectSha({}, () => "deadbeef"), "deadbeef");
  assert.equal(detectSha({}, noGit), null);
});

test("the PR number is parsed from GitHub's refs/pull/<n>/merge", () => {
  assert.equal(detectPrNumber({ GITHUB_REF: "refs/pull/42/merge" }), 42);
});

test("GitLab and Azure expose the PR number directly", () => {
  assert.equal(detectPrNumber({ CI_MERGE_REQUEST_IID: "7" }), 7);
  assert.equal(detectPrNumber({ SYSTEM_PULLREQUEST_PULLREQUESTID: "13" }), 13);
});

test("no PR context yields null (the caller sends a push)", () => {
  assert.equal(detectPrNumber({ GITHUB_REF: "refs/heads/main" }), null);
  assert.equal(detectPrNumber({}), null);
});

test("detectGitContext assembles all three, detached-HEAD CI included", () => {
  const env: Env = {
    GITHUB_HEAD_REF: "feature-x",
    GITHUB_SHA: "abc1234567",
    GITHUB_REF: "refs/pull/9/merge",
  };
  // git says "HEAD" (detached merge ref) but the env carries the real facts.
  assert.deepEqual(detectGitContext(env, () => "HEAD"), {
    branch: "feature-x",
    sha: "abc1234567",
    prNumber: 9,
  });
});
