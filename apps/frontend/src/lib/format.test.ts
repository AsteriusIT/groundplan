import { expect, it } from "vitest";

import { initials, repoName, slugify } from "./format";

it("slugify produces backend-safe slugs", () => {
  expect(slugify("Production Platform")).toBe("production-platform");
  expect(slugify("  Acme / Repo!!  ")).toBe("acme-repo");
  expect(slugify("already-good")).toBe("already-good");
  expect(slugify("!!!")).toBe("");
});

it("initials derive up to two letters from name or email", () => {
  expect(initials("Ada Lovelace", "ada@example.com")).toBe("AL");
  expect(initials(null, "grace.hopper@example.com")).toBe("GH");
  expect(initials(null, null)).toBe("?");
  expect(initials("Cher", null)).toBe("C");
});

it("repoName reduces a repo URL to owner/repo", () => {
  expect(repoName("https://github.com/acme/repo")).toBe("acme/repo");
  expect(repoName("https://github.com/acme/repo.git")).toBe("acme/repo");
  expect(repoName("https://gitlab.com/group/sub/repo.git")).toBe("group/sub/repo");
  expect(repoName("git@github.com:acme/repo.git")).toBe("acme/repo");
  // Falls back to the raw input when it can't be parsed.
  expect(repoName("not a url")).toBe("not a url");
});
