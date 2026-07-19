import assert from "node:assert/strict";
import { test } from "node:test";

import { TF_EXCLUDE_GLOB, toPosixRelative } from "./paths";

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
