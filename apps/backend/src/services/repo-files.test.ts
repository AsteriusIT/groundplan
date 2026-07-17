import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Isolate clone temp dirs to this process so the clone-cleanup assertions don't
// race with clones from other concurrently-running test files in shared /tmp.
process.env.TMPDIR = mkdtempSync(path.join(os.tmpdir(), "gp-test-tmp-"));

import {
  buildAuthenticatedUrl,
  classifyGitError,
  getFile,
  listFiles,
  listRemoteHeads,
  verifyConnection,
} from "./repo-files.js";

const exec = promisify(execFile);

let fixtureDir: string;
let fixtureUrl: string;

/** Build a throwaway local git repo so tests need no network. */
async function makeFixtureRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gp-fixture-"));
  const git = (args: string[]) => exec("git", args, { cwd: dir });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await fs.writeFile(path.join(dir, "README.md"), "# Fixture\n");
  await fs.mkdir(path.join(dir, "src"));
  await fs.writeFile(path.join(dir, "src", "main.ts"), "export const x = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "init"]);
  return dir;
}

/** Names of the service's leftover temp clone dirs, to assert cleanup. */
async function cloneTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("gp-clone-")).sort();
}

before(async () => {
  fixtureDir = await makeFixtureRepo();
  fixtureUrl = `file://${fixtureDir}`;
});

after(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("listFiles returns file paths only (no directories, no .git)", async () => {
  const files = await listFiles({
    url: fixtureUrl,
    provider: "github",
    ref: "main",
  });
  assert.deepEqual([...files].sort(), ["README.md", "src/main.ts"]);
});

test("getFile returns raw content and a matching content-type", async () => {
  const file = await getFile({
    url: fixtureUrl,
    provider: "github",
    ref: "main",
    filePath: "README.md",
  });
  assert.ok(file);
  assert.equal(file.content.toString("utf8"), "# Fixture\n");
  assert.match(file.contentType, /text\/markdown/);
});

test("getFile returns null for a missing file", async () => {
  const file = await getFile({
    url: fixtureUrl,
    provider: "github",
    ref: "main",
    filePath: "does-not-exist.txt",
  });
  assert.equal(file, null);
});

test("getFile rejects path traversal outside the repo", async () => {
  await assert.rejects(
    () =>
      getFile({
        url: fixtureUrl,
        provider: "github",
        ref: "main",
        filePath: "../../../../etc/passwd",
      }),
    /traversal|invalid path/i,
  );
});

test("verifyConnection reports ok and finds the default branch (fixture)", async () => {
  const result = await verifyConnection({
    url: fixtureUrl,
    provider: "github",
    ref: "main",
  });
  assert.deepEqual(result, { ok: true, defaultBranchFound: true });
});

test("verifyConnection reports ok but not-found for a missing branch", async () => {
  const result = await verifyConnection({
    url: fixtureUrl,
    provider: "github",
    ref: "nope",
  });
  assert.deepEqual(result, { ok: true, defaultBranchFound: false });
});

test("verifyConnection returns a structured error for an unreachable repo", async () => {
  const result = await verifyConnection({
    url: "file:///tmp/groundplan-does-not-exist-xyz",
    provider: "github",
    ref: "main",
  });
  assert.equal(result.ok, false);
});

test("listRemoteHeads never leaks the PAT into its error (redacted at source)", async () => {
  // A reserved `.invalid` host fails DNS immediately — no network egress. The raw
  // exec error would otherwise carry the authenticated URL (with the token) in
  // cmd/message/stack, which the ref-poller logs and stores as pollError.
  const token = "supersecret-pat-value-123";
  await assert.rejects(
    listRemoteHeads({
      url: "https://groundplan-nonexistent.invalid/acme/repo.git",
      provider: "github",
      accessToken: token,
    }),
    (err: unknown) => {
      const text = `${(err as Error).message}\n${(err as Error).stack ?? ""}`;
      assert.ok(!text.includes(token), "the token must not appear in the error");
      return true;
    },
  );
});

test("classifyGitError distinguishes auth / not-found / network", () => {
  assert.equal(
    classifyGitError("fatal: Authentication failed for 'https://github.com/x'"),
    "auth_failed",
  );
  assert.equal(classifyGitError("remote: Repository not found."), "not_found");
  assert.equal(
    classifyGitError("fatal: unable to access ...: Could not resolve host: github.invalid"),
    "network",
  );
});

test("buildAuthenticatedUrl injects credentials for private https repos", () => {
  // One uniform form per provider: https://{cloneUsername}:{PAT}@host/... (GP-51).
  // GitHub: x-access-token user with the token as password.
  assert.equal(
    buildAuthenticatedUrl("https://github.com/acme/repo.git", "github", "tok"),
    "https://x-access-token:tok@github.com/acme/repo.git",
  );
  // GitLab: oauth2 user with the token as password.
  assert.equal(
    buildAuthenticatedUrl("https://gitlab.com/acme/repo.git", "gitlab", "tok"),
    "https://oauth2:tok@gitlab.com/acme/repo.git",
  );
  // Azure DevOps: pat user with the token as password.
  assert.equal(
    buildAuthenticatedUrl("https://dev.azure.com/acme/infra/_git/repo", "azure_devops", "tok"),
    "https://pat:tok@dev.azure.com/acme/infra/_git/repo",
  );
  // Generic (unknown host): git user with the token as password.
  assert.equal(
    buildAuthenticatedUrl("https://git.internal.example.com/acme/repo.git", "generic", "tok"),
    "https://git:tok@git.internal.example.com/acme/repo.git",
  );
  // No token -> URL unchanged.
  assert.equal(
    buildAuthenticatedUrl("https://github.com/acme/repo.git", "github"),
    "https://github.com/acme/repo.git",
  );
  // Non-https (e.g. local fixture) -> never inject a token.
  assert.equal(
    buildAuthenticatedUrl("file:///tmp/repo", "github", "tok"),
    "file:///tmp/repo",
  );
});

test("temp clones are cleaned up on success and on error", async () => {
  const before = await cloneTempDirs();

  await listFiles({ url: fixtureUrl, provider: "github", ref: "main" });
  assert.deepEqual(await cloneTempDirs(), before, "leftover clone after success");

  await assert.rejects(() =>
    listFiles({ url: fixtureUrl, provider: "github", ref: "no-such-ref" }),
  );
  assert.deepEqual(await cloneTempDirs(), before, "leftover clone after error");
});
