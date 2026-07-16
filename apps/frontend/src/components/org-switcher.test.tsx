import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Role } from "@/api/types";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { OrgSwitcher } from "./org-switcher";

function renderSwitcher(over: Partial<OrgContextValue>) {
  const value: OrgContextValue = {
    memberships: [],
    activeOrg: null,
    singleOrg: true,
    switchOrg: vi.fn(),
    ...over,
  };
  return render(
    <OrgContext.Provider value={value}>
      <OrgSwitcher />
    </OrgContext.Provider>,
  );
}

const active = (role: Role = "owner") => ({
  id: "o1",
  name: "Acme",
  slug: "acme",
  role,
});

it("is hidden entirely in single-org mode", () => {
  const { container } = renderSwitcher({ singleOrg: true, activeOrg: active() });
  expect(container).toBeEmptyDOMElement();
});

it("shows the active org in SaaS mode", () => {
  renderSwitcher({
    singleOrg: false,
    activeOrg: active(),
    memberships: [{ role: "owner", organization: { id: "o1", name: "Acme", slug: "acme" } }],
  });
  expect(screen.getByText("Acme")).toBeInTheDocument();
  expect(screen.getByText("Organization")).toBeInTheDocument();
});
