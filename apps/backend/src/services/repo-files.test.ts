import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildAuthenticatedUrl, getFile, listFiles } from "./repo-files.js";

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

test("buildAuthenticatedUrl injects credentials for private https repos", () => {
  // GitHub: token as the username.
  assert.equal(
    buildAuthenticatedUrl("https://github.com/acme/repo.git", "github", "tok"),
    "https://tok@github.com/acme/repo.git",
  );
  // GitLab: oauth2 user with the token as password.
  assert.equal(
    buildAuthenticatedUrl("https://gitlab.com/acme/repo.git", "gitlab", "tok"),
    "https://oauth2:tok@gitlab.com/acme/repo.git",
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
