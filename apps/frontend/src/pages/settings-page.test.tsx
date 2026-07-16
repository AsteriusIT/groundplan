import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getAiStatus: vi.fn() };
});

const logout = vi.fn();
const useAuthMock = vi.fn();
vi.mock("@/auth/use-auth", () => ({ useAuth: () => useAuthMock() }));

import { getAiStatus } from "@/api/client";
import type { AiStatus, User } from "@/api/types";
import { resetAiStatus } from "@/lib/use-ai-status";
import { ThemeProvider } from "@/theme/theme-provider";
import { TourStyleProvider } from "@/tour/tour-style";
import { SettingsPage } from "./settings-page";

const getAiStatusMock = vi.mocked(getAiStatus);

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
function renderPage() {
  return render(
    <ThemeProvider>
      <TourStyleProvider>
        <SettingsPage />
      </TourStyleProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  resetAiStatus();
  getAiStatusMock.mockReset();
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

it("has no accessibility violations", async () => {
  getAiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
  const { container } = renderPage();
  await screen.findByText("claude-opus-4-8");
  const results = await axe(container);
  expect(results.violations).toEqual([]);
});
