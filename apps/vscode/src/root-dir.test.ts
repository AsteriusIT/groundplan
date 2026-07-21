/**
 * Root-dir resolution — the fix for the silent blank panel when a workspace
 * keeps its Terraform below the root. Pure functions, no `vscode` import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectRootCandidates,
  detectRootDir,
  normalizeRootSetting,
  resolveRootDir,
  stackForFile,
} from "./root-dir";

const TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n';
const tf = (path: string, content = TF): { path: string; content: string } => ({
  path,
  content,
});

test("workspace root holding .tf stays the entrypoint, subdirs or not", () => {
  assert.equal(detectRootDir([tf("main.tf"), tf("modules/net/net.tf")]), "");
});

test("a single sub-directory stack is found", () => {
  assert.equal(detectRootDir([tf("infra/main.tf"), tf("infra/vars.tf")]), "infra");
});

test("no Terraform at all detects the root (an empty parse, said openly)", () => {
  assert.equal(detectRootDir([]), "");
});

test("a directory sourced as a module is never the entrypoint", () => {
  const files = [
    tf(
      "envs/prod/main.tf",
      'module "net" {\n  source = "../../modules/net"\n}\n',
    ),
    tf("modules/net/net.tf"),
  ];
  // "modules/net" is shallower than "envs/prod", but it is a module.
  assert.equal(detectRootDir(files), "envs/prod");
});

test("./-relative module sources resolve against the referencing directory", () => {
  const files = [
    tf("stack/main.tf", 'module "net" {\n  source = "./modules/net"\n}\n'),
    tf("stack/modules/net/net.tf"),
  ];
  assert.equal(detectRootDir(files), "stack");
});

test("several stacks pick the shallowest, then alphabetical — deterministic", () => {
  assert.equal(detectRootDir([tf("a/deep/stack/main.tf"), tf("b/main.tf")]), "b");
  assert.equal(
    detectRootDir([tf("envs/prod/main.tf"), tf("envs/dev/main.tf")]),
    "envs/dev",
  );
});

test("registry and git module sources exclude nothing", () => {
  const files = [
    tf(
      "infra/main.tf",
      'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n',
    ),
  ];
  assert.equal(detectRootDir(files), "infra");
});

test("mutual references fall back to every dir rather than none", () => {
  const files = [
    tf("a/main.tf", 'module "b" {\n  source = "../b"\n}\n'),
    tf("b/main.tf", 'module "a" {\n  source = "../a"\n}\n'),
  ];
  assert.equal(detectRootDir(files), "a");
});

test("non-.tf files are ignored by detection", () => {
  assert.equal(
    detectRootDir([tf("README.md", "# hi"), tf("infra/main.tf")]),
    "infra",
  );
});

test("normalizeRootSetting: dots, slashes, backslashes, whitespace", () => {
  assert.equal(normalizeRootSetting(""), "");
  assert.equal(normalizeRootSetting("."), "");
  assert.equal(normalizeRootSetting("./"), "");
  assert.equal(normalizeRootSetting("infra"), "infra");
  assert.equal(normalizeRootSetting("./infra/"), "infra");
  assert.equal(normalizeRootSetting("/infra/"), "infra");
  assert.equal(normalizeRootSetting(" envs/prod "), "envs/prod");
  assert.equal(normalizeRootSetting("envs\\prod"), "envs/prod");
});

test("resolveRootDir: a configured root wins verbatim, even when empty of .tf", () => {
  const files = [tf("infra/main.tf")];
  assert.equal(resolveRootDir("./envs/prod/", null, files), "envs/prod");
  assert.equal(resolveRootDir("", null, files), "infra");
  assert.equal(resolveRootDir(".", null, files), "infra");
});

test("detectRootCandidates lists every stack, sorted, modules excluded", () => {
  const files = [
    tf("envs/prod/main.tf", 'module "net" {\n  source = "../../modules/net"\n}\n'),
    tf("envs/dev/main.tf"),
    tf("apps/api/main.tf"),
    tf("modules/net/net.tf"),
  ];
  assert.deepEqual(detectRootCandidates(files), [
    "apps/api",
    "envs/dev",
    "envs/prod",
  ]);
});

test("a root holding .tf is a candidate alongside sub-directory stacks", () => {
  const files = [tf("main.tf"), tf("envs/prod/main.tf")];
  assert.deepEqual(detectRootCandidates(files), ["", "envs/prod"]);
});

test("no Terraform anywhere means no candidates", () => {
  assert.deepEqual(detectRootCandidates([]), []);
});

test("stackForFile names the stack a file belongs to", () => {
  const candidates = ["envs/dev", "envs/prod"];
  assert.equal(stackForFile("envs/prod/main.tf", candidates), "envs/prod");
  assert.equal(stackForFile("envs/dev/vars.tf", candidates), "envs/dev");
});

test("stackForFile: a shared module file belongs to no stack — stay put", () => {
  assert.equal(
    stackForFile("modules/net/net.tf", ["envs/dev", "envs/prod"]),
    null,
  );
});

test("stackForFile: the most specific stack wins over the workspace root", () => {
  const candidates = ["", "envs/prod"];
  assert.equal(stackForFile("envs/prod/main.tf", candidates), "envs/prod");
  // Anything else still belongs to the root stack.
  assert.equal(stackForFile("main.tf", candidates), "");
  assert.equal(stackForFile("scripts/x.tf", candidates), "");
});

test("stackForFile: a sibling directory sharing a name prefix is not a match", () => {
  assert.equal(stackForFile("envs/prod-eu/main.tf", ["envs/prod"]), null);
});

test("resolveRootDir: a remembered stack wins over detection while it exists", () => {
  const files = [tf("envs/dev/main.tf"), tf("envs/prod/main.tf")];
  assert.equal(resolveRootDir("", "envs/prod", files), "envs/prod");
  // A stale memory (directory gone) falls back to detection, not to a blank.
  assert.equal(resolveRootDir("", "envs/gone", files), "envs/dev");
  // The explicit setting still beats the remembered choice.
  assert.equal(resolveRootDir("infra", "envs/prod", files), "infra");
});
