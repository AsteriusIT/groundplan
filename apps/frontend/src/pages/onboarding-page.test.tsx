import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, createOrganization: vi.fn() };
});

import { ApiError, createOrganization } from "@/api/client";
import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { OnboardingPage } from "./onboarding-page";

const createOrgMock = vi.mocked(createOrganization);
const reloadUser = vi.fn();
const switchOrg = vi.fn();

function auth(): AuthContextValue {
  return {
    user: { id: "u1", email: null, display_name: null, memberships: [], singleOrg: false },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    handleCallback: vi.fn(),
    reloadUser,
  };
}

function org(over: Partial<OrgContextValue> = {}): OrgContextValue {
  return {
    memberships: [],
    activeOrg: null,
    singleOrg: false,
    switchOrg,
    ...over,
  };
}

function renderPage(orgValue = org()) {
  return render(
    <AuthContext.Provider value={auth()}>
      <OrgContext.Provider value={orgValue}>
        <MemoryRouter initialEntries={["/onboarding"]}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/dashboard" element={<div>dashboard</div>} />
          </Routes>
        </MemoryRouter>
      </OrgContext.Provider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  createOrgMock.mockReset();
  reloadUser.mockReset();
  switchOrg.mockReset();
});

it("creates an org, refreshes, switches to it, and lands on the dashboard", async () => {
  createOrgMock.mockResolvedValue({
    id: "o9",
    name: "Acme",
    slug: "acme",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  renderPage();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme" } });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  await waitFor(() => expect(createOrgMock).toHaveBeenCalledWith({ name: "Acme", slug: "acme" }));
  await screen.findByText("dashboard");
  expect(reloadUser).toHaveBeenCalledTimes(1);
  expect(switchOrg).toHaveBeenCalledWith("o9");
});

it("shows the server error and stays on the form", async () => {
  createOrgMock.mockRejectedValue(new ApiError(409, "slug 'acme' already exists"));
  renderPage();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme" } });
  fireEvent.click(screen.getByRole("button", { name: /create organization/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
});

it("redirects away when the user already has an org", () => {
  renderPage(
    org({ activeOrg: { id: "o1", name: "X", slug: "x", role: "owner" } }),
  );
  expect(screen.getByText("dashboard")).toBeInTheDocument();
});
