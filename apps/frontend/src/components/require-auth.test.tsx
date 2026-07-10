import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { RequireAuth } from "./require-auth";

function renderGuard(auth: Partial<AuthContextValue>) {
  const value: AuthContextValue = {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    handleCallback: vi.fn(),
    ...auth,
  };
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <div>protected content</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

it("redirects unauthenticated users to /login", () => {
  renderGuard({ isAuthenticated: false, isLoading: false });
  expect(screen.getByText("login page")).toBeInTheDocument();
  expect(screen.queryByText("protected content")).not.toBeInTheDocument();
});

it("renders children when authenticated", () => {
  renderGuard({ isAuthenticated: true });
  expect(screen.getByText("protected content")).toBeInTheDocument();
});

it("renders neither content nor a redirect while loading", () => {
  renderGuard({ isLoading: true });
  expect(screen.queryByText("protected content")).not.toBeInTheDocument();
  expect(screen.queryByText("login page")).not.toBeInTheDocument();
});
