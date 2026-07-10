import { expect, it } from "vitest";

import { initials, slugify } from "./format";

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
