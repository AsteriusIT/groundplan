import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Role } from "@/api/types";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { useCan } from "./use-can";

function Probe() {
  return (
    <div>
      <span data-testid="manage">{String(useCan("project:manage"))}</span>
      <span data-testid="delete">{String(useCan("org:delete"))}</span>
    </div>
  );
}

function renderAs(role: Role | null) {
  const value: OrgContextValue = {
    memberships: [],
    activeOrg: role ? { id: "o1", name: "A", slug: "a", role } : null,
    singleOrg: false,
    switchOrg: vi.fn(),
  };
  render(
    <OrgContext.Provider value={value}>
      <Probe />
    </OrgContext.Provider>,
  );
}

it("grants an admin project management but not org deletion", () => {
  renderAs("admin");
  expect(screen.getByTestId("manage")).toHaveTextContent("true");
  expect(screen.getByTestId("delete")).toHaveTextContent("false");
});

it("grants an owner everything", () => {
  renderAs("owner");
  expect(screen.getByTestId("manage")).toHaveTextContent("true");
  expect(screen.getByTestId("delete")).toHaveTextContent("true");
});

it("denies a member management actions", () => {
  renderAs("member");
  expect(screen.getByTestId("manage")).toHaveTextContent("false");
});

it("denies everything when there is no active org", () => {
  renderAs(null);
  expect(screen.getByTestId("manage")).toHaveTextContent("false");
  expect(screen.getByTestId("delete")).toHaveTextContent("false");
});
