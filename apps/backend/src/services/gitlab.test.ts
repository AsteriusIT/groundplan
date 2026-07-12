import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGitLabRepo } from "./gitlab.js";

test("parseGitLabRepo derives the v4 API base + project path (gitlab.com)", () => {
  assert.deepEqual(parseGitLabRepo("https://gitlab.com/acme/infra.git"), {
    apiBase: "https://gitlab.com/api/v4",
    projectPath: "acme/infra",
  });
  assert.deepEqual(parseGitLabRepo("https://gitlab.com/acme/infra"), {
    apiBase: "https://gitlab.com/api/v4",
    projectPath: "acme/infra",
  });
});

test("parseGitLabRepo derives the base from the host (self-hosted, subgroups)", () => {
  assert.deepEqual(
    parseGitLabRepo("https://gitlab.example.com/group/sub/repo/"),
    { apiBase: "https://gitlab.example.com/api/v4", projectPath: "group/sub/repo" },
  );
});

test("parseGitLabRepo returns null for a non-URL or a group-less path", () => {
  assert.equal(parseGitLabRepo("not a url"), null);
  assert.equal(parseGitLabRepo("https://gitlab.com/justarepo"), null);
});
