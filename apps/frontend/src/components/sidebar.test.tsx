import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { Sidebar } from "./sidebar";

function renderSidebar(
  auth: Partial<AuthContextValue> = {},
  path = "/projects",
): AuthContextValue {
  const value: AuthContextValue = {
    user: { id: "u1", email: "ada@example.com", display_name: "Ada Lovelace" },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    handleCallback: vi.fn(),
    ...auth,
  };
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </AuthContext.Provider>,
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

it("signs out from the user card", () => {
  const value = renderSidebar();
  fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
  expect(value.logout).toHaveBeenCalledTimes(1);
});
