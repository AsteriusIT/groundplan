import { test } from "node:test";
import assert from "node:assert/strict";

import { InvalidRepoPathError, normalizeTerraformPath } from "./repo-path.js";

test("an empty path means the repository root", () => {
  assert.equal(normalizeTerraformPath(""), "");
  assert.equal(normalizeTerraformPath(null), "");
  assert.equal(normalizeTerraformPath(undefined), "");
  assert.equal(normalizeTerraformPath("  "), "");
  // The ways a user says "the root" all collapse to the same stored value.
  assert.equal(normalizeTerraformPath("/"), "");
  assert.equal(normalizeTerraformPath("."), "");
  assert.equal(normalizeTerraformPath("./"), "");
});

test("a path is stored as a clean posix relative path", () => {
  assert.equal(normalizeTerraformPath("infra"), "infra");
  assert.equal(normalizeTerraformPath("/infra/"), "infra");
  assert.equal(normalizeTerraformPath("./infra/azure"), "infra/azure");
  assert.equal(normalizeTerraformPath("  infra/azure  "), "infra/azure");
  assert.equal(normalizeTerraformPath("infra//azure"), "infra/azure");
  // Windows-style separators are accepted and normalized — people paste them.
  assert.equal(normalizeTerraformPath("infra\\azure"), "infra/azure");
});

test("a path may not escape the repository", () => {
  for (const bad of ["..", "../infra", "infra/../..", "infra/../../secrets"]) {
    assert.throws(
      () => normalizeTerraformPath(bad),
      InvalidRepoPathError,
      `expected ${bad} to be rejected`,
    );
  }

  // A `..` that stays inside the repo is fine — it is just a clumsy path.
  assert.equal(normalizeTerraformPath("infra/../infra/azure"), "infra/azure");
  // …including one that walks all the way back to the root it started from.
  assert.equal(normalizeTerraformPath("infra/azure/../.."), "");
});

test("a path may not be absolute or contain a null byte", () => {
  assert.throws(() => normalizeTerraformPath("C:\\infra"), InvalidRepoPathError);
  assert.throws(() => normalizeTerraformPath("infra\0/azure"), InvalidRepoPathError);
});
