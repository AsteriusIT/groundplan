import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import type { Role } from "@/api/types";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { OrgSwitcher } from "./org-switcher";

let lastPath = "";
function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

function renderSwitcher(over: Partial<OrgContextValue>) {
  const value: OrgContextValue = {
    memberships: [],
    activeOrg: null,
    singleOrg: true,
    switchOrg: vi.fn(),
    ...over,
  };
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <OrgContext.Provider value={value}>
        <OrgSwitcher />
        <LocationProbe />
      </OrgContext.Provider>
    </MemoryRouter>,
  );
}

const active = (role: Role = "owner") => ({
  id: "o1",
  name: "Acme",
  slug: "acme",
  role,
});

/** Radix opens a menu on keyboard activation; jsdom has no real pointer. */
function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /acme/i }), {
    key: "Enter",
  });
}

it("is hidden entirely when there is no active org", () => {
  const { container } = renderSwitcher({ singleOrg: false, activeOrg: null });
  expect(container).toBeEmptyDOMElement();
});

it("shows the active org in SaaS mode", () => {
  renderSwitcher({
    singleOrg: false,
    activeOrg: active(),
    memberships: [
      { role: "owner", organization: { id: "o1", name: "Acme", slug: "acme" } },
    ],
  });
  expect(screen.getByText("Acme")).toBeInTheDocument();
  expect(screen.getByText("Organization")).toBeInTheDocument();
});

it("offers the switch list and the settings entry in SaaS mode", async () => {
  renderSwitcher({
    singleOrg: false,
    activeOrg: active(),
    memberships: [
      { role: "owner", organization: { id: "o1", name: "Acme", slug: "acme" } },
      { role: "member", organization: { id: "o2", name: "Beta", slug: "beta" } },
    ],
  });
  openMenu();
  expect(await screen.findByText("Switch organization")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /beta/i })).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: /organization settings/i }),
  ).toBeInTheDocument();
});

it("still shows a popover with the settings entry in single-org mode (GP-189)", async () => {
  renderSwitcher({ singleOrg: true, activeOrg: active() });
  openMenu();
  expect(
    await screen.findByRole("menuitem", { name: /organization settings/i }),
  ).toBeInTheDocument();
  // No switch list — there is nothing to switch between.
  expect(screen.queryByText("Switch organization")).not.toBeInTheDocument();
});

it("navigates to the current org's settings page", async () => {
  renderSwitcher({ singleOrg: true, activeOrg: active() });
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /organization settings/i }),
  );
  expect(lastPath).toBe("/orgs/o1/settings");
});

it("targets the newly selected org after a switch", async () => {
  const switchOrg = vi.fn();
  const { rerender } = renderSwitcher({
    singleOrg: false,
    switchOrg,
    activeOrg: active(),
    memberships: [
      { role: "owner", organization: { id: "o1", name: "Acme", slug: "acme" } },
      { role: "member", organization: { id: "o2", name: "Beta", slug: "beta" } },
    ],
  });

  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /beta/i }));
  expect(switchOrg).toHaveBeenCalledWith("o2");

  // The provider would flip the active org; the settings entry then targets it.
  rerender(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <OrgContext.Provider
        value={{
          memberships: [
            {
              role: "owner",
              organization: { id: "o1", name: "Acme", slug: "acme" },
            },
            {
              role: "member",
              organization: { id: "o2", name: "Beta", slug: "beta" },
            },
          ],
          activeOrg: { id: "o2", name: "Beta", slug: "beta", role: "member" },
          singleOrg: false,
          switchOrg,
        }}
      >
        <OrgSwitcher />
        <LocationProbe />
      </OrgContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: /beta/i }), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /organization settings/i }),
  );
  expect(lastPath).toBe("/orgs/o2/settings");
});
