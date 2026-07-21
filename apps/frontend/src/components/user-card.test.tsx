import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { UserCard } from "./user-card";

function renderCard(
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
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <UserCard />
        <Routes>
          <Route path="/settings" element={<div>settings landed</div>} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return value;
}

/** Radix opens a menu on keyboard activation; jsdom has no real pointer. */
function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /ada lovelace/i }), {
    key: "Enter",
  });
}

it("shows the signed-in identity on the card", () => {
  renderCard();
  expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  // Avatar initials, as everywhere else in the app.
  expect(screen.getByText("AL")).toBeInTheDocument();
});

it("has no standalone sign-out icon — the card is a menu trigger (GP-186)", () => {
  renderCard();
  expect(
    screen.queryByRole("button", { name: /sign out/i }),
  ).not.toBeInTheDocument();
  // Nothing is open until the card is activated.
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("opens the account menu with Settings and Sign out", async () => {
  renderCard();
  openMenu();
  expect(
    await screen.findByRole("menuitem", { name: /settings/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: /sign out/i }),
  ).toBeInTheDocument();
});

it("closes on Escape", async () => {
  renderCard();
  openMenu();
  await screen.findByRole("menuitem", { name: /settings/i });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("navigates to personal settings from the menu", async () => {
  renderCard();
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /settings/i }));
  expect(await screen.findByText("settings landed")).toBeInTheDocument();
});

it("signs out from the menu", async () => {
  const value = renderCard();
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));
  expect(value.logout).toHaveBeenCalledTimes(1);
});

it("carries the active-route treatment for /settings (GP-186)", () => {
  renderCard({}, "/settings");
  expect(
    screen.getByRole("button", { name: /ada lovelace/i }),
  ).toHaveAttribute("aria-current", "page");
});

it("is not marked current away from /settings", () => {
  renderCard({}, "/projects");
  expect(
    screen.getByRole("button", { name: /ada lovelace/i }),
  ).not.toHaveAttribute("aria-current");
});
