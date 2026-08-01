/**
 * The baseline-mode helpers. The wire owns the type, so it owns the validator
 * and the label decomposition too — both bundles import them from here, and a
 * second copy on the webview side is how the two ends drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  branchMode,
  branchRefOf,
  isBaselineMode,
  shortRef,
  type BaselineMode,
} from "./messages";

test("a branch mode round-trips through its full ref", () => {
  const mode = branchMode("refs/remotes/origin/release/2.4");
  assert.equal(mode, "branch:refs/remotes/origin/release/2.4");
  assert.equal(branchRefOf(mode), "refs/remotes/origin/release/2.4");
});

test("the two fixed modes carry no branch ref", () => {
  assert.equal(branchRefOf("head"), null);
  assert.equal(branchRefOf("merge-base"), null);
});

test("shortRef names a branch the way a reader does", () => {
  assert.equal(shortRef("refs/heads/master"), "master");
  assert.equal(shortRef("refs/remotes/origin/release/2.4"), "origin/release/2.4");
  // Anything else is shown verbatim rather than mangled by a wrong guess.
  assert.equal(shortRef("refs/tags/v1"), "refs/tags/v1");
});

test("isBaselineMode accepts the fixed modes and a fully-qualified branch", () => {
  assert.ok(isBaselineMode("head"));
  assert.ok(isBaselineMode("merge-base"));
  assert.ok(isBaselineMode("branch:refs/heads/master"));
  assert.ok(isBaselineMode("branch:refs/remotes/origin/feature/a-b_c.d"));
});

test("isBaselineMode rejects anything that could not be handed to git", () => {
  const bad: unknown[] = [
    undefined,
    null,
    42,
    "",
    "branch",
    "branch:",
    // Short names are ambiguous (local `master` vs `origin/master`) and a
    // leading "-" would be read by git as an option.
    "branch:master",
    "branch:--upload-pack=evil",
    // Ref-format violations git itself would refuse.
    "branch:refs/heads/a..b",
    "branch:refs/heads/a b",
    "branch:refs/heads/a\tb",
    "branch:refs/heads/a\nb",
    "branch:refs/heads/a\0b",
    "branch:refs/heads/a^b",
    "branch:refs/heads/a:b",
    "branch:refs/heads/a?b",
    "branch:refs/heads/x.lock",
    "branch:refs/heads/",
    "branch:refs//heads/x",
    "branch:refs/heads/.hidden",
    `branch:refs/heads/${"a".repeat(300)}`,
  ];
  for (const value of bad) {
    assert.equal(isBaselineMode(value), false, `must reject ${JSON.stringify(value)}`);
  }
});

test("a validated mode is usable as a BaselineMode without a cast", () => {
  const value: unknown = "branch:refs/heads/master";
  assert.ok(isBaselineMode(value));
  // Type-level: the narrowing above is what lets prefs parsing avoid an
  // `as BaselineMode` on untrusted stored input.
  const mode: BaselineMode = value;
  assert.equal(branchRefOf(mode), "refs/heads/master");
});
