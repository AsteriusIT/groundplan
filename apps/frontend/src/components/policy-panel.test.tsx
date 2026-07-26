import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    listWaivers: vi.fn(),
    createWaiver: vi.fn(),
    revokeWaiver: vi.fn(),
  };
});

let canManage = true;
vi.mock("@/rbac/use-can", () => ({ useCan: () => canManage }));

import { createWaiver, listWaivers, revokeWaiver } from "@/api/client";

import type {
  PolicyDelta,
  PolicyReport,
  PolicyViolation,
  PolicyWaiver,
} from "@/api/types";
import { findingsByNode } from "@/lib/policy";
import { PolicyPanel } from "./policy-panel";

function violation(over: Partial<PolicyViolation> = {}): PolicyViolation {
  return {
    ruleId: "nsg-open-to-internet",
    severity: "error",
    address: "azurerm_network_security_group.web",
    message: "This network security group has an inbound Allow rule open to the internet.",
    hint: "Restrict source_address_prefix.",
    ...over,
  };
}

const TLS = violation({
  ruleId: "weak-tls",
  severity: "warning",
  address: "azurerm_storage_account.logs",
  message: "TLS minimum is set to TLS1_0.",
});

function report(violations: PolicyViolation[]): PolicyReport {
  return {
    version: 2,
    target: "terraform",
    status: "failing",
    counts: { error: 1, warning: 0, info: 0, waived: 0, total: violations.length },
    violations,
    rules: [
      { ruleId: "nsg-open-to-internet", enabled: true, severity: "error", applicable: true },
      { ruleId: "weak-tls", enabled: true, severity: "warning", applicable: true },
    ],
  };
}

function delta(over: Partial<PolicyDelta> = {}): PolicyDelta {
  return {
    version: 1,
    added: [],
    resolved: [],
    preexisting: [],
    status: "passing",
    baseSnapshotId: "base-1",
    ...over,
  };
}

const listWaiversMock = vi.mocked(listWaivers);
const createWaiverMock = vi.mocked(createWaiver);
const revokeWaiverMock = vi.mocked(revokeWaiver);

function waiver(over: Partial<PolicyWaiver> = {}): PolicyWaiver {
  return {
    id: "w1",
    repositoryId: "r1",
    ruleId: "nsg-open-to-internet",
    address: "azurerm_network_security_group.web",
    reason: "public CDN origin",
    status: "active",
    expiresAt: null,
    revokedAt: null,
    createdBy: "u1",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  canManage = true;
  vi.clearAllMocks();
  listWaiversMock.mockResolvedValue([]);
  createWaiverMock.mockResolvedValue(waiver());
  revokeWaiverMock.mockResolvedValue(undefined);
});

it("separates what the change introduced from the estate's existing debt", () => {
  render(
    <PolicyPanel
      report={report([violation(), TLS])}
      delta={delta({ added: [TLS], preexisting: [violation()], status: "warnings" })}
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText(/Introduced by this change · 1/)).toBeTruthy();
  expect(screen.getByText(/Already on the default branch · 1/)).toBeTruthy();
  expect(screen.getByText("Warnings")).toBeTruthy();
});

it("clicking a violation asks for its resource", () => {
  const onSelectAddress = vi.fn();
  render(
    <PolicyPanel
      report={report([violation()])}
      delta={delta({ added: [violation()], status: "failing" })}
      onSelectAddress={onSelectAddress}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByText("azurerm_network_security_group.web"),
  );
  expect(onSelectAddress).toHaveBeenCalledWith(
    "azurerm_network_security_group.web",
  );
});

it("says a change introduced nothing rather than showing an empty list", () => {
  render(
    <PolicyPanel
      report={report([])}
      delta={delta()}
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByText(/Nothing new. This change introduces no violations./),
  ).toBeTruthy();
});

it("a waived violation is shown with its reason, never hidden", () => {
  const waived = violation({
    waiver: { id: "w1", reason: "public CDN origin", expiresAt: null },
  });
  render(
    <PolicyPanel
      report={report([waived])}
      delta={null}
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText(/Waived: public CDN origin/)).toBeTruthy();
  // …and it does not wear a canvas badge: it has been answered.
  expect(findingsByNode([waived]).size).toBe(0);
});

it("a snapshot no rule could judge is not reported as a pass", () => {
  render(
    <PolicyPanel
      report={{
        ...report([]),
        status: "passing",
        rules: [
          {
            ruleId: "nsg-open-to-internet",
            enabled: true,
            severity: "error",
            applicable: false,
          },
        ],
      }}
      delta={null}
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText(/No enabled rule applies to this snapshot/)).toBeTruthy();
});

it("has no axe violations", async () => {
  const { baseElement } = render(
    <main>
      <PolicyPanel
        report={report([violation(), TLS])}
        delta={delta({ added: [TLS], preexisting: [violation()] })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />
    </main>,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});

// --- Waivers (GP-204) --------------------------------------------------------

it("an admin can waive a violation, with a reason", async () => {
  const onChanged = vi.fn();
  render(
    <PolicyPanel
      report={report([violation()])}
      delta={null}
      repositoryId="r1"
      onChanged={onChanged}
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Waive…/ }));
  const reason = screen.getByLabelText("Reason");
  // The reason is what makes a waiver reviewable — no reason, no waiver.
  expect(screen.getByRole("button", { name: /^Waive$/ })).toBeDisabled();
  fireEvent.change(reason, { target: { value: "public ingress by design" } });
  fireEvent.click(screen.getByRole("button", { name: /^Waive$/ }));

  await waitFor(() => expect(createWaiverMock).toHaveBeenCalledTimes(1));
  expect(createWaiverMock.mock.calls[0]![1]).toEqual({
    ruleId: "nsg-open-to-internet",
    address: "azurerm_network_security_group.web",
    reason: "public ingress by design",
    expiresAt: null,
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it("a member sees the violations but is offered no waiver controls", async () => {
  canManage = false;
  render(
    <PolicyPanel
      report={report([violation()])}
      delta={null}
      repositoryId="r1"
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText(/nsg-open-to-internet/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Waive…/ })).toBeNull();
});

it("a waiver whose resource is gone is shown rather than silently dropped", async () => {
  listWaiversMock.mockResolvedValue([
    waiver({ status: "orphaned", address: "azurerm_subnet.deleted" }),
  ]);
  render(
    <PolicyPanel
      report={report([])}
      delta={null}
      repositoryId="r1"
      onSelectAddress={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(await screen.findByText(/Waivers with no resource/)).toBeTruthy();
  expect(screen.getByText("azurerm_subnet.deleted")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Withdraw it/ }));
  await waitFor(() => expect(revokeWaiverMock).toHaveBeenCalledWith("w1"));
});
