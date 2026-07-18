import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { ThemeProvider } from "@/theme/theme-provider";
import { Sidebar } from "./sidebar";

// Single-org context: the org switcher is hidden, so the nav stays as before.
const orgValue: OrgContextValue = {
  memberships: [],
  activeOrg: null,
  singleOrg: true,
  switchOrg: vi.fn(),
};

function renderSidebar(
  auth: Partial<AuthContextValue> = {},
  path = "/projects",
): AuthContextValue {
  const value: AuthContextValue = {
    user: {
      id: "u1",
      email: "ada@example.com",
      display_name: "Ada Lovelace",
      memberships: [],
      singleOrg: true,
    },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    handleCallback: vi.fn(),
    reloadUser: vi.fn(),
    ...auth,
  };
  render(
    <ThemeProvider>
      <AuthContext.Provider value={value}>
        <OrgContext.Provider value={orgValue}>
          <MemoryRouter initialEntries={[path]}>
            <Sidebar />
          </MemoryRouter>
        </OrgContext.Provider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
  return value;
}

it("shows the signed-in user's name and email", () => {
  renderSidebar();
  expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  expect(screen.getByText("ada@example.com")).toBeInTheDocument();
});

it("highlights the active route and not the others", () => {
  renderSidebar({}, "/projects");
  expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
    "aria-current",
  );
});

it("puts Clusters beside Projects — a cluster is not inside one", () => {
  renderSidebar({}, "/clusters");

  const clusters = screen.getByRole("link", { name: "Clusters" });
  expect(clusters).toHaveAttribute("href", "/clusters");
  expect(clusters).toHaveAttribute("aria-current", "page");

  // The five top-level places, in order.
  expect(
    screen.getAllByRole("link").map((a) => a.textContent),
  ).toEqual(["Dashboard", "Projects", "Clusters", "Playground", "Settings"]);
});

it("signs out from the user card", () => {
  const value = renderSidebar();
  fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
  expect(value.logout).toHaveBeenCalledTimes(1);
});
