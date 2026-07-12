import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAzureDevOpsRepo } from "./azure-devops.js";

test("parseAzureDevOpsRepo handles the dev.azure.com form", () => {
  assert.deepEqual(
    parseAzureDevOpsRepo("https://dev.azure.com/myorg/myproject/_git/myrepo"),
    { apiBase: "https://dev.azure.com/myorg", project: "myproject", repo: "myrepo" },
  );
});

test("parseAzureDevOpsRepo handles the legacy visualstudio.com form", () => {
  assert.deepEqual(
    parseAzureDevOpsRepo("https://myorg.visualstudio.com/myproject/_git/myrepo.git"),
    { apiBase: "https://myorg.visualstudio.com", project: "myproject", repo: "myrepo" },
  );
});

test("parseAzureDevOpsRepo derives the base from the host for ADO Server", () => {
  assert.deepEqual(
    parseAzureDevOpsRepo("https://tfs.example.com/tfs/DefaultCollection/myproject/_git/myrepo"),
    {
      apiBase: "https://tfs.example.com/tfs/DefaultCollection",
      project: "myproject",
      repo: "myrepo",
    },
  );
});

test("parseAzureDevOpsRepo returns null for a non-URL or a URL without /_git/", () => {
  assert.equal(parseAzureDevOpsRepo("not a url"), null);
  assert.equal(parseAzureDevOpsRepo("https://dev.azure.com/org/project"), null);
});
