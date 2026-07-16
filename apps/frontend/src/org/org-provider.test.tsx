import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import type { Membership, User } from "@/api/types";
import { OrgProvider } from "./org-provider";
import { useOrg } from "./use-org";

function membership(slug: string, id: string, role: Membership["role"]): Membership {
  return { role, organization: { id, name: slug.toUpperCase(), slug } };
}

function authValue(user: User | null): AuthContextValue {
  return {
    user,
    isAuthenticated: user !== null,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    handleCallback: vi.fn(),
    reloadUser: vi.fn(),
  };
}

function Probe() {
  const { activeOrg, memberships, singleOrg, switchOrg } = useOrg();
  return (
    <div>
      <span data-testid="active">{activeOrg?.slug ?? "none"}</span>
      <span data-testid="role">{activeOrg?.role ?? "none"}</span>
      <span data-testid="count">{memberships.length}</span>
      <span data-testid="single">{String(singleOrg)}</span>
      {memberships.map((m) => (
        <button
          key={m.organization.id}
          onClick={() => switchOrg(m.organization.id)}
        >
          go-{m.organization.slug}
        </button>
      ))}
    </div>
  );
}

function renderWithUser(user: User | null) {
  return render(
    <AuthContext.Provider value={authValue(user)}>
      <OrgProvider>
        <Probe />
      </OrgProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

it("makes the first membership active and exposes the role", () => {
  renderWithUser({
    id: "u1",
    email: null,
    display_name: null,
    singleOrg: false,
    memberships: [
      membership("alpha", "o1", "owner"),
      membership("beta", "o2", "member"),
    ],
  });
  expect(screen.getByTestId("active")).toHaveTextContent("alpha");
  expect(screen.getByTestId("role")).toHaveTextContent("owner");
  expect(screen.getByTestId("count")).toHaveTextContent("2");
  expect(screen.getByTestId("single")).toHaveTextContent("false");
});

it("switches the active org and remembers it", () => {
  renderWithUser({
    id: "u1",
    email: null,
    display_name: null,
    singleOrg: false,
    memberships: [
      membership("alpha", "o1", "owner"),
      membership("beta", "o2", "member"),
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "go-beta" }));
  expect(screen.getByTestId("active")).toHaveTextContent("beta");
  expect(screen.getByTestId("role")).toHaveTextContent("member");
  expect(localStorage.getItem("groundplan.activeOrgId")).toBe("o2");
});

it("has no active org when the user belongs to nothing", () => {
  renderWithUser({
    id: "u1",
    email: null,
    display_name: null,
    singleOrg: false,
    memberships: [],
  });
  expect(screen.getByTestId("active")).toHaveTextContent("none");
});

it("falls back to the first membership when the stored id is stale", () => {
  localStorage.setItem("groundplan.activeOrgId", "gone");
  renderWithUser({
    id: "u1",
    email: null,
    display_name: null,
    singleOrg: false,
    memberships: [membership("alpha", "o1", "admin")],
  });
  expect(screen.getByTestId("active")).toHaveTextContent("alpha");
});
