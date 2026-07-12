import { test } from "node:test";
import assert from "node:assert/strict";

import { cloneUsername, detectProvider, PROVIDERS } from "./providers.js";

test("detectProvider maps known hosts to their provider", () => {
  assert.equal(detectProvider("https://github.com/acme/infra.git"), "github");
  assert.equal(detectProvider("https://gitlab.com/acme/infra"), "gitlab");
  assert.equal(detectProvider("https://dev.azure.com/acme/infra/_git/repo"), "azure_devops");
  assert.equal(detectProvider("https://acme.visualstudio.com/infra/_git/repo"), "azure_devops");
});

test("detectProvider falls back to generic for unknown / self-hosted hosts", () => {
  assert.equal(detectProvider("https://git.internal.example.com/acme/infra.git"), "generic");
  assert.equal(detectProvider("https://gitlab.example.com/acme/infra"), "generic");
});

test("detectProvider is case-insensitive on the host", () => {
  assert.equal(detectProvider("https://GitHub.com/Acme/Infra"), "github");
});

test("detectProvider returns generic for an unparseable URL", () => {
  assert.equal(detectProvider("not a url"), "generic");
});

test("cloneUsername follows the per-provider credential table", () => {
  assert.equal(cloneUsername("github"), "x-access-token");
  assert.equal(cloneUsername("gitlab"), "oauth2");
  assert.equal(cloneUsername("azure_devops"), "pat");
  assert.equal(cloneUsername("generic"), "git");
});

test("PROVIDERS lists every provider exactly once", () => {
  assert.deepEqual([...PROVIDERS], ["github", "gitlab", "azure_devops", "generic"]);
});
