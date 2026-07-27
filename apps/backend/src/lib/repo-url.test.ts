import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOwnerRepo, repoUrlKey, sameRepoUrl } from "./repo-url.js";

test("the same repository spelled several ways compares equal", () => {
  const spellings = [
    "https://github.com/acme/infra",
    "https://github.com/acme/infra.git",
    "https://github.com/acme/infra/",
    "https://GitHub.com/acme/infra",
    "HTTPS://github.com/acme/infra",
    "  https://github.com/acme/infra  ",
  ];
  for (const spelling of spellings) {
    assert.equal(
      repoUrlKey(spelling),
      "https://github.com/acme/infra",
      spelling,
    );
  }
});

test("a token pasted into the URL never becomes part of the key", () => {
  const key = repoUrlKey("https://x-access-token:ghs_secret@github.com/acme/infra");
  assert.equal(key, "https://github.com/acme/infra");
  assert.ok(!key.includes("ghs_secret"), "the key must not carry a credential");
});

test("query and fragment are not part of a clone target", () => {
  assert.equal(
    repoUrlKey("https://github.com/acme/infra?tab=readme#top"),
    "https://github.com/acme/infra",
  );
});

test("the path stays case-sensitive: two repos are not silently merged", () => {
  assert.equal(sameRepoUrl("https://github.com/acme/Infra", "https://github.com/acme/infra"), false);
});

test("different repositories, hosts and protocols never collide", () => {
  assert.equal(
    sameRepoUrl("https://github.com/acme/infra", "https://github.com/acme/other"),
    false,
  );
  assert.equal(
    sameRepoUrl("https://github.com/acme/infra", "https://gitlab.com/acme/infra"),
    false,
  );
  assert.equal(
    sameRepoUrl("https://git.example.com/a/b", "http://git.example.com/a/b"),
    false,
  );
});

test("an unparseable remote still compares equal to itself", () => {
  assert.equal(repoUrlKey("git@github.com:acme/infra.git"), "git@github.com:acme/infra");
  assert.ok(sameRepoUrl("git@github.com:acme/infra.git", "git@github.com:acme/infra"));
  assert.equal(repoUrlKey(""), "");
  assert.equal(repoUrlKey("   "), "");
});

test("owner/name is read from a URL or a bare full name, owner lowercased", () => {
  assert.deepEqual(parseOwnerRepo("https://github.com/Acme/Infra.git"), {
    owner: "acme",
    name: "Infra",
  });
  assert.deepEqual(parseOwnerRepo("Acme/infra"), { owner: "acme", name: "infra" });
  assert.deepEqual(
    parseOwnerRepo("https://dev.azure.com/acme/project/_git/repo"),
    { owner: "_git", name: "repo" },
  );
});

test("owner/name is null when there is no repository in the URL", () => {
  assert.equal(parseOwnerRepo("https://github.com/acme"), null);
  assert.equal(parseOwnerRepo("infra"), null);
  assert.equal(parseOwnerRepo(""), null);
});
