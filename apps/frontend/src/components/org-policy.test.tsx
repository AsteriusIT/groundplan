import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { getOrgPolicyConfig, saveOrgPolicyConfig } from "@/api/client";
import type { OrgPolicyConfig, PolicyCatalogEntry } from "@/api/types";
import { OrgPolicy } from "./org-policy";

const getMock = vi.mocked(getOrgPolicyConfig);
const saveMock = vi.mocked(saveOrgPolicyConfig);

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

function config(over: Partial<OrgPolicyConfig> = {}): OrgPolicyConfig {
  return {
    scope: "organization",
    rules: {},
    catalog: [
      rule(),
      rule({
        ruleId: "required-tags",
        title: "Required tags are present",
        description: "Every taggable resource declares the keys you require.",
        enabled: false,
        severity: "warning",
        defaultEnabled: false,
        defaultSeverity: "warning",
        params: { keys: ["environment", "owner"] },
      }),
    ],
    ...over,
  };
}

beforeEach(() => {
  canManage = true;
  vi.clearAllMocks();
  getMock.mockResolvedValue(config());
  saveMock.mockImplementation(async (rules) => config({ rules }));
});

it("lists the whole catalogue, including the rules that are off", async () => {
  render(<OrgPolicy />);
  expect(
    await screen.findByText("No security group open to the internet"),
  ).toBeTruthy();
  // A rule that is not enforced is shown, not hidden — a list that hides what it
  // does not run reads as a clean bill of health.
  expect(screen.getByText("Required tags are present")).toBeTruthy();
  const toggles = screen.getAllByRole("switch");
  expect(toggles[0]!.getAttribute("aria-checked")).toBe("true");
  expect(toggles[1]!.getAttribute("aria-checked")).toBe("false");
});

it("saves only what was changed, as an override document", async () => {
  render(<OrgPolicy />);
  const toggle = await screen.findByRole("switch", {
    name: /Enable No security group open to the internet/,
  });
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: /Save policy/ }));

  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  expect(saveMock.mock.calls[0]![0]).toEqual({
    "nsg-open-to-internet": { enabled: false },
  });
});

it("changing a severity records only the severity", async () => {
  render(<OrgPolicy />);
  const warning = (
    await screen.findAllByRole("button", { name: "warning" })
  )[0]!;
  fireEvent.click(warning);
  fireEvent.click(screen.getByRole("button", { name: /Save policy/ }));

  await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
  expect(saveMock.mock.calls[0]![0]).toEqual({
    "nsg-open-to-internet": { severity: "warning" },
  });
});

it("a member sees the rules but gets no controls to change them", async () => {
  canManage = false;
  render(<OrgPolicy />);
  expect(
    await screen.findByText("No security group open to the internet"),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Save policy/ })).toBeNull();
  const toggle = screen.getAllByRole("switch")[0]!;
  expect(toggle.hasAttribute("disabled")).toBe(true);
});

it("has no axe violations", async () => {
  const { baseElement } = render(
    <main>
      <OrgPolicy />
    </main>,
  );
  await screen.findByText("No security group open to the internet");
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
