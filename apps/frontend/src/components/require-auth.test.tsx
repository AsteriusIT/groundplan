import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { RequireAuth } from "./require-auth";

function renderGuard(auth: Partial<AuthContextValue>, path = "/dashboard") {
  const value: AuthContextValue = {
    user: null,
    isAuthenticated: false,
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
        <RequireAuth>
          <div>protected content</div>
        </RequireAuth>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return value;
}

it("starts the OIDC sign-in for unauthenticated users, preserving the target path", () => {
  const login = vi.fn();
  renderGuard(
    { isAuthenticated: false, isLoading: false, login },
    "/invite/abc?x=1",
  );
  expect(login).toHaveBeenCalledTimes(1);
  expect(login).toHaveBeenCalledWith("/invite/abc?x=1");
  expect(screen.queryByText("protected content")).not.toBeInTheDocument();
});

it("preserves the hash through the sign-in round trip (settings section anchors)", () => {
  const login = vi.fn();
  renderGuard(
    { isAuthenticated: false, isLoading: false, login },
    "/settings#ci-token",
  );
  expect(login).toHaveBeenCalledWith("/settings#ci-token");
});

it("renders children when authenticated", () => {
  renderGuard({ isAuthenticated: true });
  expect(screen.getByText("protected content")).toBeInTheDocument();
});

it("waits while loading — no redirect, no content", () => {
  const login = vi.fn();
  renderGuard({ isLoading: true, login });
  expect(login).not.toHaveBeenCalled();
  expect(screen.queryByText("protected content")).not.toBeInTheDocument();
});

it("keeps waiting while loading even once authenticated (profile not yet loaded)", () => {
  // On session restore, isAuthenticated flips true before GET /me resolves, so
  // there is a window where the user (and thus their org memberships) is still
  // null. Rendering children here lets <RequireOrg> mistake a not-yet-loaded
  // user for an org-less one and bounce to /onboarding.
  renderGuard({ isAuthenticated: true, isLoading: true });
  expect(screen.queryByText("protected content")).not.toBeInTheDocument();
});
