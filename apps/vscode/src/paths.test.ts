import assert from "node:assert/strict";
import { test } from "node:test";

import { TF_EXCLUDE_GLOB, isDiagramTf, toPosixRelative } from "./paths";

test("paths become posix and repository-relative, whatever the platform gave us", () => {
  assert.equal(
    toPosixRelative("/home/me/repo", "/home/me/repo/modules/net/main.tf"),
    "modules/net/main.tf",
  );
  assert.equal(
    toPosixRelative("C:\\repo", "C:\\repo\\modules\\net\\main.tf"),
    "modules/net/main.tf",
  );
  assert.equal(toPosixRelative("/repo", "/repo/main.tf"), "main.tf");
});

test("the exclude glob keeps vendored Terraform out of the parse", () => {
  assert.match(TF_EXCLUDE_GLOB, /\.terraform/);
  assert.match(TF_EXCLUDE_GLOB, /node_modules/);
});

test("isDiagramTf mirrors TF_EXCLUDE_GLOB for paths that never pass a glob", () => {
  assert.equal(isDiagramTf("main.tf"), true);
  assert.equal(isDiagramTf("envs/prod/main.tf"), true);
  assert.equal(isDiagramTf("readme.md"), false);
  assert.equal(isDiagramTf(".terraform/modules/x/main.tf"), false);
  assert.equal(isDiagramTf("modules/node_modules/pkg/main.tf"), false);
  // A directory merely *named* like one is still ours.
  assert.equal(isDiagramTf("terraform/main.tf"), true);
});
