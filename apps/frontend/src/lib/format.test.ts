import { expect, it } from "vitest";

import {
  branchName,
  initials,
  relativeTime,
  repoName,
  shortSha,
  slugify,
} from "./format";

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

it("relativeTime says how long ago an instant was", () => {
  const now = new Date("2026-07-13T12:00:00.000Z");
  const ago = (iso: string) => relativeTime(iso, now);

  expect(ago("2026-07-13T11:59:30.000Z")).toBe("just now");
  expect(ago("2026-07-13T11:46:00.000Z")).toBe("14 min ago");
  expect(ago("2026-07-13T09:00:00.000Z")).toBe("3 hours ago");
  expect(ago("2026-07-13T11:00:00.000Z")).toBe("1 hour ago");
  expect(ago("2026-07-11T12:00:00.000Z")).toBe("2 days ago");
  expect(ago("2026-07-12T12:00:00.000Z")).toBe("1 day ago");

  // Past a month the age stops being the point — show the date instead.
  expect(ago("2026-01-02T12:00:00.000Z")).toBe("02 Jan 2026");
  // A clock skew from the server must never render "-3 min ago".
  expect(ago("2026-07-13T12:05:00.000Z")).toBe("just now");
  expect(ago("nonsense")).toBe("nonsense");
});
