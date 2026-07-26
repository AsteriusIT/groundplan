import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getOrgPolicyConfig: vi.fn(),
    saveOrgPolicyConfig: vi.fn(),
  };
});

let canManage = true;
vi.mock("@/rbac/use-can", () => ({ useCan: () => canManage }));

import { getOrgPolicyConfig } from "@/api/client";
import type { OrgPolicyConfig, PolicyCatalogEntry } from "@/api/types";
import type { OrgContextValue } from "@/org/org-context";
import { OrgContext } from "@/org/org-context";
import { PoliciesPage } from "./policies-page";

const getMock = vi.mocked(getOrgPolicyConfig);

function rule(over: Partial<PolicyCatalogEntry> = {}): PolicyCatalogEntry {
  return {
    ruleId: "nsg-open-to-internet",
    title: "No security group open to the internet",
    description: "An inbound Allow rule whose source is the internet.",
    enabled: true,
    severity: "error",
    applicable: true,
    defaultSeverity: "error",
    defaultEnabled: true,
    appliesTo: ["terraform"],
    configured: false,
    ...over,
  };
}

const config: OrgPolicyConfig = {
  scope: "organization",
  rules: {},
  catalog: [rule()],
};

const orgValue: OrgContextValue = {
  memberships: [],
  activeOrg: { id: "o1", name: "Acme", slug: "acme", role: "owner" },
  singleOrg: false,
  switchOrg: vi.fn(),
};

function renderPage(org: Partial<OrgContextValue> = {}) {
  // <main> is the landmark AppLayout renders the outlet inside — the page is
  // never mounted without one, and axe rightly asks for it.
  return render(
    <MemoryRouter initialEntries={["/policies"]}>
      <OrgContext.Provider value={{ ...orgValue, ...org }}>
        <main>
          <PoliciesPage />
        </main>
      </OrgContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  canManage = true;
  vi.clearAllMocks();
  getMock.mockResolvedValue(config);
});

it("is a page of its own, headed by the org it applies to", async () => {
  renderPage();
  expect(
    screen.getByRole("heading", { name: "Policies", level: 1 }),
  ).toBeInTheDocument();
  expect(screen.getByText(/checked against in Acme/)).toBeInTheDocument();
  expect(
    await screen.findByText("No security group open to the internet"),
  ).toBeInTheDocument();
});

it("points at the dashboard for where repositories stand — compliance has one home", () => {
  renderPage();
  expect(screen.getByRole("link", { name: "dashboard" })).toHaveAttribute(
    "href",
    "/dashboard",
  );
});

it("a member reads the catalogue and is offered nothing to change", async () => {
  canManage = false;
  renderPage();
  expect(
    await screen.findByText("No security group open to the internet"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Save policy/ })).toBeNull();
});

it("has no axe violations", async () => {
  const { baseElement } = renderPage();
  await screen.findByText("No security group open to the internet");
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
