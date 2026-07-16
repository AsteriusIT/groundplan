import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, acceptInvitation: vi.fn() };
});

import { acceptInvitation, ApiError } from "@/api/client";
import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { InvitePage } from "./invite-page";

const acceptMock = vi.mocked(acceptInvitation);
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

const orgValue: OrgContextValue = {
  memberships: [],
  activeOrg: null,
  singleOrg: false,
  switchOrg,
};

function renderPage() {
  return render(
    <AuthContext.Provider value={auth()}>
      <OrgContext.Provider value={orgValue}>
        <MemoryRouter initialEntries={["/invite/tok-123"]}>
          <Routes>
            <Route path="/invite/:token" element={<InvitePage />} />
            <Route path="/dashboard" element={<div>dashboard</div>} />
          </Routes>
        </MemoryRouter>
      </OrgContext.Provider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  acceptMock.mockReset();
  reloadUser.mockReset();
  switchOrg.mockReset();
});

it("accepts the invite, switches to the org, and lands on the dashboard", async () => {
  acceptMock.mockResolvedValue({
    organization: { id: "o5", name: "Acme", slug: "acme" },
  });
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /accept invitation/i }));

  await waitFor(() => expect(acceptMock).toHaveBeenCalledWith("tok-123"));
  await screen.findByText("dashboard");
  expect(switchOrg).toHaveBeenCalledWith("o5");
});

it("shows a clear error for an expired or invalid invite", async () => {
  acceptMock.mockRejectedValue(new ApiError(410, "this invitation has expired"));
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /accept invitation/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("expired");
  expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
});
