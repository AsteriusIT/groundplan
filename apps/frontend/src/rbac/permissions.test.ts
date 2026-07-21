import { expect, it } from "vitest";

import { can, roleAtLeast } from "./permissions";

it("owner > admin > member in the hierarchy", () => {
  expect(roleAtLeast("owner", "admin")).toBe(true);
  expect(roleAtLeast("admin", "owner")).toBe(false);
  expect(roleAtLeast("member", "member")).toBe(true);
});

it("gates the matrix as the backend does", () => {
  // member: read only
  expect(can("member", "org:read")).toBe(true);
  expect(can("member", "project:manage")).toBe(false);
  expect(can("member", "integration:manage")).toBe(false);
  expect(can("member", "member:manage")).toBe(false);

  // admin: manage projects, repos, integrations, members
  expect(can("admin", "project:manage")).toBe(true);
  expect(can("admin", "integration:manage")).toBe(true);
  expect(can("admin", "member:manage")).toBe(true);
  expect(can("admin", "org:delete")).toBe(false);
  expect(can("admin", "ownership:transfer")).toBe(false);

  // owner: everything, incl. destructive org ops
  expect(can("owner", "org:delete")).toBe(true);
  expect(can("owner", "ownership:transfer")).toBe(true);
});
