import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { axe } from "vitest-axe";

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
import type { OrgContextValue } from "@/org/org-context";
import { OrgContext } from "@/org/org-context";
import type { Role } from "@/api/types";
import { resetAiStatus } from "@/lib/use-ai-status";
import { PanelPrefsProvider } from "@/panel/panel-prefs";
import { ThemeProvider } from "@/theme/theme-provider";
import { TourStyleProvider } from "@/tour/tour-style";
import { OrgSettingsPage } from "./org-settings-page";

const getAiStatusMock = vi.mocked(getAiStatus);
const getIngestionSettingsMock = vi.mocked(getIngestionSettings);
const listMembersMock = vi.mocked(listMembers);
const listInvitationsMock = vi.mocked(listInvitations);
const listIntegrationsMock = vi.mocked(listIntegrations);

const orgValue: OrgContextValue = {
  memberships: [],
  activeOrg: { id: "o1", name: "Acme", slug: "acme", role: "member" },
  singleOrg: false,
  switchOrg: vi.fn(),
};

function active(role: Role, over: Partial<OrgContextValue["activeOrg"]> = {}) {
  return { id: "o1", name: "Acme", slug: "acme", role, ...over };
}

let lastPath = "";
function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

function renderPage(
  org: Partial<OrgContextValue> = {},
  { orgIdInUrl = "o1", hash = "" }: { orgIdInUrl?: string; hash?: string } = {},
) {
  const value = { ...orgValue, ...org };
  return render(
    <MemoryRouter initialEntries={[`/orgs/${orgIdInUrl}/settings${hash}`]}>
      <ThemeProvider>
        <TourStyleProvider>
          <PanelPrefsProvider>
            <OrgContext.Provider value={value}>
              <Routes>
                <Route
                  path="/orgs/:orgId/settings"
                  element={<OrgSettingsPage />}
                />
              </Routes>
              <LocationProbe />
            </OrgContext.Provider>
          </PanelPrefsProvider>
        </TourStyleProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function rail() {
  return screen.getByRole("navigation", { name: /settings sections/i });
}

function railLinks() {
  return within(rail())
    .getAllByRole("link")
    .map((a) => a.textContent);
}

beforeEach(() => {
  resetAiStatus();
  getAiStatusMock.mockReset();
  getAiStatusMock.mockResolvedValue({ enabled: false, model: null });
  getIngestionSettingsMock.mockReset();
  getIngestionSettingsMock.mockResolvedValue({
    appWebhookTokenSet: false,
    updatedAt: null,
  });
  listMembersMock.mockReset();
  listMembersMock.mockResolvedValue([]);
  listInvitationsMock.mockReset();
  listInvitationsMock.mockResolvedValue([]);
  listIntegrationsMock.mockReset();
  listIntegrationsMock.mockResolvedValue([]);
  logout.mockReset();
  localStorage.clear();
  useAuthMock.mockReturnValue({
    user: {
      id: "u1",
      email: "ada@example.com",
      display_name: "Ada Lovelace",
      memberships: [],
      singleOrg: false,
    },
    logout,
    reloadUser: vi.fn(),
    isAuthenticated: true,
    isLoading: false,
  });
});

it("renders the org-scoped sections and none of the personal ones", () => {
  renderPage({ activeOrg: active("owner") });

  // Org sections present.
  expect(railLinks()).toContain("Members");
  expect(railLinks()).toContain("Integrations");
  expect(railLinks()).toContain("CI ingestion token");
  expect(railLinks()).toContain("AI");
  // Personal sections stay on /settings (GP-187), not here.
  expect(railLinks()).not.toContain("Account");
  expect(railLinks()).not.toContain("Appearance");
});

it("shows a member the roster and integrations, but no invites or danger zone", () => {
  renderPage({ activeOrg: active("member") });
  expect(railLinks()).toEqual([
    "Members",
    "Integrations",
    "CI ingestion token",
    "AI",
  ]);
  // No admin-only controls leak in: no invite form, no delete button.
  expect(
    screen.queryByRole("button", { name: /delete organization/i }),
  ).not.toBeInTheDocument();
});

it("adds invitations for an admin, still no danger zone", () => {
  renderPage({ activeOrg: active("admin") });
  expect(railLinks()).toEqual([
    "Members",
    "Integrations",
    "Invitations",
    "CI ingestion token",
    "AI",
  ]);
  expect(
    screen.queryByRole("button", { name: /delete organization/i }),
  ).not.toBeInTheDocument();
});

it("adds invitations and the danger zone for an owner", () => {
  renderPage({ activeOrg: active("owner") });
  expect(railLinks()).toEqual([
    "Members",
    "Integrations",
    "Invitations",
    "CI ingestion token",
    "AI",
    "Danger zone",
  ]);
  expect(
    screen.getByRole("button", { name: /delete organization/i }),
  ).toBeInTheDocument();
});

it("works in single-org mode: sections render, invites/danger hidden", () => {
  renderPage({ singleOrg: true, activeOrg: active("owner") });
  expect(railLinks()).toEqual([
    "Members",
    "Integrations",
    "CI ingestion token",
    "AI",
  ]);
});

it("brings a stale URL org back to the active org (GP-188)", async () => {
  // On /orgs/OTHER/settings while acting in o1 → redirect to o1's page.
  renderPage({ activeOrg: active("member") }, { orgIdInUrl: "some-other-org" });
  await waitFor(() => expect(lastPath).toBe("/orgs/o1/settings"));
});

it("leaves a matching URL untouched", async () => {
  renderPage({ activeOrg: active("member") }, { orgIdInUrl: "o1" });
  await waitFor(() => expect(lastPath).toBe("/orgs/o1/settings"));
  expect(listMembersMock).toHaveBeenCalled();
});

it("has no accessibility violations", async () => {
  // Member view (no manage column in the roster table) — the same config the
  // personal page's axe check uses.
  getAiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
  const { container } = renderPage({ activeOrg: active("member") });
  await screen.findByText("claude-opus-4-8");
  const results = await axe(container);
  expect(results.violations).toEqual([]);
});
