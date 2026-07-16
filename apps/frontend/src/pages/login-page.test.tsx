import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { LoginPage } from "./login-page";

function renderLogin(auth: Partial<AuthContextValue>): AuthContextValue {
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
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>home page</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return value;
}

it("clicking Sign in triggers login()", () => {
  const value = renderLogin({});
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  expect(value.login).toHaveBeenCalledTimes(1);
});

it("redirects to home when already authenticated", () => {
  renderLogin({ isAuthenticated: true });
  expect(screen.getByText("home page")).toBeInTheDocument();
});
