import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getAiStatus: vi.fn(),
    listMembers: vi.fn(),
    listInvitations: vi.fn(),
  };
});

const logout = vi.fn();
const useAuthMock = vi.fn();
vi.mock("@/auth/use-auth", () => ({ useAuth: () => useAuthMock() }));

import { getAiStatus, listInvitations, listMembers } from "@/api/client";
import type { AiStatus, User } from "@/api/types";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { resetAiStatus } from "@/lib/use-ai-status";
import { ThemeProvider } from "@/theme/theme-provider";
import { TourStyleProvider } from "@/tour/tour-style";
import { SettingsPage } from "./settings-page";

const getAiStatusMock = vi.mocked(getAiStatus);
const listMembersMock = vi.mocked(listMembers);
const listInvitationsMock = vi.mocked(listInvitations);

// Single-org context: the members roster shows; invites and danger zone hide.
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
          <OrgContext.Provider value={{ ...orgValue, ...org }}>
            <SettingsPage />
          </OrgContext.Provider>
        </TourStyleProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetAiStatus();
  getAiStatusMock.mockReset();
  listMembersMock.mockReset();
  listMembersMock.mockResolvedValue([]);
  listInvitationsMock.mockReset();
  listInvitationsMock.mockResolvedValue([]);
  logout.mockReset();
  localStorage.clear();
  useAuthMock.mockReturnValue({
    user: user(),
    logout,
    isAuthenticated: true,
    isLoading: false,
  });
  getAiStatusMock.mockResolvedValue({ enabled: false, model: null });
});

it("shows the identity from the token, and says who owns it", async () => {
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

it("reports the AI layer as on, with the model that generates", async () => {
  getAiStatusMock.mockResolvedValue({
    enabled: true,
    model: "claude-opus-4-8",
  } satisfies AiStatus);
  renderPage();

  expect(await screen.findByText(/enabled/i)).toBeInTheDocument();
  expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
});

it("explains where AI is configured when it is off", async () => {
  getAiStatusMock.mockResolvedValue({ enabled: false, model: null });
  renderPage();

  expect(await screen.findByText(/disabled/i)).toBeInTheDocument();
  expect(screen.getByText(/AI_API_KEY/)).toBeInTheDocument();
  // Config is server-side by design (GP-62) — no key input in the UI.
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

function rail() {
  return screen.getByRole("navigation", { name: /settings sections/i });
}

it("lists exactly the rendered sections in the rail", () => {
  renderPage(); // single-org member: no invitations, no danger zone
  const links = within(rail())
    .getAllByRole("link")
    .map((a) => a.textContent);
  expect(links).toEqual([
    "Account",
    "Appearance",
    "Members",
    "CI ingestion token",
    "AI",
  ]);
});

it("adds invitations and the danger zone for a multi-org owner", () => {
  renderPage({
    singleOrg: false,
    activeOrg: { id: "o1", name: "Asterius", slug: "asterius", role: "owner" },
  });
  const links = within(rail())
    .getAllByRole("link")
    .map((a) => a.textContent);
  expect(links).toEqual([
    "Account",
    "Appearance",
    "Members",
    "Invitations",
    "CI ingestion token",
    "AI",
    "Danger zone",
  ]);
  // …and the sections themselves render.
  expect(
    screen.getByRole("button", { name: /delete organization/i }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/email \(optional\)/i)).toBeInTheDocument();
});

it("anchors rail links to their sections", () => {
  renderPage();
  const account = within(rail()).getByRole("link", { name: "Account" });
  expect(account).toHaveAttribute("href", "#account");
  expect(document.getElementById("account")).not.toBeNull();
});

it("marks the first section as current where nothing has scrolled", () => {
  renderPage(); // jsdom: no IntersectionObserver, spy stays on the first id
  expect(within(rail()).getByRole("link", { name: "Account" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(
    within(rail()).getByRole("link", { name: "Members" }),
  ).not.toHaveAttribute("aria-current");
});

it("pins a clicked section as current — the tail can never reach the reading line", () => {
  renderPage();
  fireEvent.click(within(rail()).getByRole("link", { name: "AI" }));
  expect(within(rail()).getByRole("link", { name: "AI" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

it("unpins on real scrolling, returning the highlight to the spy", () => {
  renderPage();
  fireEvent.click(within(rail()).getByRole("link", { name: "AI" }));
  fireEvent.wheel(window);
  expect(within(rail()).getByRole("link", { name: "Account" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

it("pins the section named by the URL hash on arrival", () => {
  window.history.replaceState(null, "", "#ci-token");
  try {
    renderPage();
    expect(
      within(rail()).getByRole("link", { name: "CI ingestion token" }),
    ).toHaveAttribute("aria-current", "true");
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

it("labels the groups in the rail only — never duplicated over the cards", () => {
  renderPage();
  for (const label of ["Personal", "Organization", "Workspace"]) {
    within(rail()).getByText(label);
    expect(screen.getAllByText(label)).toHaveLength(1);
  }
});

it("tints the danger zone card destructive", () => {
  renderPage({
    singleOrg: false,
    activeOrg: { id: "o1", name: "Asterius", slug: "asterius", role: "owner" },
  });
  const section = document.getElementById("danger")?.querySelector("section");
  expect(section?.className).toContain("border-destructive/40");
});

it("has no accessibility violations", async () => {
  getAiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
  const { container } = renderPage();
  await screen.findByText("claude-opus-4-8");
  const results = await axe(container);
  expect(results.violations).toEqual([]);
});
