import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

// The personal page fetches no org or workspace data (GP-187). We still mock
// these so a stray call would be observable — every test asserts they stay
// untouched.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getAiStatus: vi.fn(),
    getIngestionSettings: vi.fn(),
    listMembers: vi.fn(),
    listInvitations: vi.fn(),
    listIntegrations: vi.fn(),
  };
});

const logout = vi.fn();
const useAuthMock = vi.fn();
vi.mock("@/auth/use-auth", () => ({ useAuth: () => useAuthMock() }));

import {
  getAiStatus,
  getIngestionSettings,
  listIntegrations,
  listInvitations,
  listMembers,
} from "@/api/client";
import type { User } from "@/api/types";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { resetAiStatus } from "@/lib/use-ai-status";
import { PANEL_MODE_STORAGE_KEY, PanelPrefsProvider } from "@/panel/panel-prefs";
import { ThemeProvider } from "@/theme/theme-provider";
import { TourStyleProvider } from "@/tour/tour-style";
import { SettingsPage } from "./settings-page";

const listMembersMock = vi.mocked(listMembers);
const listInvitationsMock = vi.mocked(listInvitations);
const listIntegrationsMock = vi.mocked(listIntegrations);
const getAiStatusMock = vi.mocked(getAiStatus);
const getIngestionSettingsMock = vi.mocked(getIngestionSettings);

const orgValue: OrgContextValue = {
  memberships: [],
  activeOrg: { id: "o1", name: "Default", slug: "default", role: "member" },
  singleOrg: true,
  switchOrg: vi.fn(),
};

function user(over: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "ada@example.com",
    display_name: "Ada Lovelace",
    memberships: [],
    singleOrg: true,
    ...over,
  };
}

/** The appearance card writes through the two display-preference providers. */
function renderPage(org: Partial<OrgContextValue> = {}) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <TourStyleProvider>
          <PanelPrefsProvider>
            <OrgContext.Provider value={{ ...orgValue, ...org }}>
              <SettingsPage />
            </OrgContext.Provider>
          </PanelPrefsProvider>
        </TourStyleProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetAiStatus();
  getAiStatusMock.mockReset();
  getIngestionSettingsMock.mockReset();
  listMembersMock.mockReset();
  listInvitationsMock.mockReset();
  listIntegrationsMock.mockReset();
  logout.mockReset();
  localStorage.clear();
  useAuthMock.mockReturnValue({
    user: user(),
    logout,
    isAuthenticated: true,
    isLoading: false,
  });
});

it("shows the identity from the token, and says who owns it", () => {
  renderPage();

  expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  // Avatar initials, as everywhere else in the app.
  expect(screen.getByText("AL")).toBeInTheDocument();
  expect(
    screen.getByText(/managed by your identity provider/i),
  ).toBeInTheDocument();
});

it("signs out from the account section", () => {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
  expect(logout).toHaveBeenCalledTimes(1);
});

it("copes with a token that carries no name or email", () => {
  useAuthMock.mockReturnValue({
    user: user({ display_name: null, email: null }),
    logout,
    isAuthenticated: true,
    isLoading: false,
  });
  renderPage();
  expect(screen.getByText("Signed in")).toBeInTheDocument();
});

it("changes the theme, reflects it immediately, and persists the choice", () => {
  renderPage();
  const root = document.documentElement;

  fireEvent.click(screen.getByRole("button", { name: "Blueprint" }));
  expect(root.classList.contains("dark")).toBe(true);
  expect(root.dataset.theme).toBeUndefined(); // carbon is the only data-theme
  expect(localStorage.getItem("groundplan-theme")).toBe("blueprint");
  expect(screen.getByRole("button", { name: "Blueprint" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  fireEvent.click(screen.getByRole("button", { name: "Carbon" }));
  expect(root.dataset.theme).toBe("carbon");

  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(root.classList.contains("dark")).toBe(false);
  expect(localStorage.getItem("groundplan-theme")).toBe("light");
});

it("switches the details panel to resizable and persists the choice", () => {
  renderPage();

  const resizable = screen.getByRole("button", { name: "Resizable" });
  expect(resizable).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(resizable);
  expect(localStorage.getItem(PANEL_MODE_STORAGE_KEY)).toBe("resizable");
  expect(resizable).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(screen.getByRole("button", { name: "Fixed" }));
  expect(localStorage.getItem(PANEL_MODE_STORAGE_KEY)).toBe("fixed");
});

it("renders only the personal sections — no organization or workspace ones", () => {
  renderPage();
  // Only Account + Appearance headings.
  expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Appearance" }),
  ).toBeInTheDocument();
  for (const moved of [
    "Members",
    "Integrations",
    "Invitations",
    "CI ingestion token",
    "AI",
    "Danger zone",
  ]) {
    expect(
      screen.queryByRole("heading", { name: moved }),
    ).not.toBeInTheDocument();
  }
  // …and there is no longer a section rail (two sections don't warrant it).
  expect(
    screen.queryByRole("navigation", { name: /settings sections/i }),
  ).not.toBeInTheDocument();
});

it("fetches no organization or workspace data", () => {
  renderPage();
  expect(listMembersMock).not.toHaveBeenCalled();
  expect(listInvitationsMock).not.toHaveBeenCalled();
  expect(listIntegrationsMock).not.toHaveBeenCalled();
  expect(getAiStatusMock).not.toHaveBeenCalled();
  expect(getIngestionSettingsMock).not.toHaveBeenCalled();
});

it("is available to a user with no active org and no membership", () => {
  renderPage({ activeOrg: null, memberships: [] });
  expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Appearance" }),
  ).toBeInTheDocument();
});

it("keeps the #account / #appearance anchors for deep links", () => {
  renderPage();
  expect(document.getElementById("account")).not.toBeNull();
  expect(document.getElementById("appearance")).not.toBeNull();
});

it("has no accessibility violations", async () => {
  const { container } = renderPage();
  const results = await axe(container);
  expect(results.violations).toEqual([]);
});
