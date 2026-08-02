import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthContext, type AuthContextValue } from "@/auth/auth-context";
import { OrgContext, type OrgContextValue } from "@/org/org-context";
import { ThemeProvider } from "@/theme/theme-provider";
import { Sidebar } from "./sidebar";
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SidebarPrefsProvider,
} from "./sidebar-prefs";

const orgValue: OrgContextValue = {
  memberships: [],
  activeOrg: { id: "o1", name: "Acme", slug: "acme", role: "owner" },
  singleOrg: true,
  switchOrg: vi.fn(),
};

const auth: AuthContextValue = {
  user: {
    id: "u1",
    email: "ada@example.com",
    display_name: "Ada Lovelace",
    memberships: [],
    singleOrg: true,
  },
  isAuthenticated: true,
  isLoading: false,
  login: vi.fn(),
  logout: vi.fn(),
  handleCallback: vi.fn(),
  reloadUser: vi.fn(),
};

function renderSidebar(path = "/projects") {
  return render(
    <ThemeProvider>
      <AuthContext.Provider value={auth}>
        <OrgContext.Provider value={orgValue}>
          <SidebarPrefsProvider>
            <MemoryRouter initialEntries={[path]}>
              <Sidebar />
            </MemoryRouter>
          </SidebarPrefsProvider>
        </OrgContext.Provider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

it("folds to a rail and back from one labelled control", () => {
  renderSidebar();
  expect(screen.getByText("groundplan")).toBeInTheDocument();

  const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(collapse);

  // The wordmark and the nav labels go; the destinations do not.
  expect(screen.queryByText("groundplan")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "href",
    "/projects",
  );
  const expand = screen.getByRole("button", { name: "Expand sidebar" });
  expect(expand).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(expand);
  expect(screen.getByText("groundplan")).toBeInTheDocument();
});

it("keeps the mode switcher, the org and the account reachable on the rail", () => {
  renderSidebar();
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(
    screen.getByRole("button", { name: "Mode: Terraform Documentation" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Organization: Acme" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Ada Lovelace" }),
  ).toBeInTheDocument();
});

it("remembers the choice across a remount", () => {
  const { unmount } = renderSidebar();
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");

  unmount();
  renderSidebar();
  expect(
    screen.getByRole("button", { name: "Expand sidebar" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("groundplan")).not.toBeInTheDocument();
});

it("toggles on Ctrl+B, but not while somebody is typing", () => {
  renderSidebar();
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  expect(
    screen.getByRole("button", { name: "Expand sidebar" }),
  ).toBeInTheDocument();

  const input = document.createElement("input");
  document.body.appendChild(input);
  fireEvent.keyDown(input, { key: "b", ctrlKey: true });
  expect(
    screen.getByRole("button", { name: "Expand sidebar" }),
  ).toBeInTheDocument();
  input.remove();
});

it("tells the window the layout changed once the width lands", () => {
  const onResize = vi.fn();
  window.addEventListener("resize", onResize);
  renderSidebar();

  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  // jsdom runs no animations: the transition end is what a browser fires when
  // the rail has finished narrowing, and what the canvas beside it waits for.
  fireEvent.transitionEnd(screen.getByRole("complementary"), {
    propertyName: "width",
  });
  expect(onResize).toHaveBeenCalled();

  window.removeEventListener("resize", onResize);
});
