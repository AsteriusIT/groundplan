import { expect, it } from "vitest";

import { branchName, initials, repoName, shortSha, slugify } from "./format";

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

it("branchName strips the refs/heads prefix CI sends", () => {
  expect(branchName("refs/heads/feature-x")).toBe("feature-x");
  expect(branchName("refs/heads/release/1.2")).toBe("release/1.2");
  // Already a bare branch name — left alone.
  expect(branchName("main")).toBe("main");
});

it("shortSha keeps the first 8 characters", () => {
  expect(shortSha("0123456789abcdef")).toBe("01234567");
  expect(shortSha("abc")).toBe("abc");
});

it("repoName reduces a repo URL to owner/repo", () => {
  expect(repoName("https://github.com/acme/repo")).toBe("acme/repo");
  expect(repoName("https://github.com/acme/repo.git")).toBe("acme/repo");
  expect(repoName("https://gitlab.com/group/sub/repo.git")).toBe("group/sub/repo");
  expect(repoName("git@github.com:acme/repo.git")).toBe("acme/repo");
  // Falls back to the raw input when it can't be parsed.
  expect(repoName("not a url")).toBe("not a url");
});
