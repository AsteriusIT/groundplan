import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { Reconciliation } from "@/api/types";
import { RealityPanel } from "./reality-panel";

const reconciliation = (over: Partial<Reconciliation> = {}): Reconciliation => ({
  version: 1,
  graph: { version: 7, nodes: [], edges: [] },
  counts: { unmanaged: 1, notApplied: 1, divergent: 1, matching: 4 },
  unmanaged: ["azurerm_storage_account.tmp"],
  notApplied: ["azurerm_subnet.web"],
  divergent: ["azurerm_virtual_network.main"],
  summaryMd: "",
  code: {
    snapshotId: "s1",
    ref: "main",
    commitSha: "abcdef1234567890",
    createdAt: "2026-07-26T09:00:00.000Z",
  },
  reality: {
    snapshotId: "s2",
    ref: "main",
    commitSha: "abcdef1234567890",
    observedAt: new Date(Date.now() - 3_600_000).toISOString(),
    terraformVersion: "1.9.5",
  },
  ...over,
});

describe("RealityPanel (GP-209)", () => {
  it("names the three findings in reconciliation words, not plan words", () => {
    render(
      <RealityPanel
        result={reconciliation()}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/not managed by this repository/i)).toBeInTheDocument();
    expect(screen.getByText(/declared but not found/i)).toBeInTheDocument();
    expect(screen.getByText(/disagreeing/i)).toBeInTheDocument();

    expect(screen.getByText("azurerm_storage_account.tmp")).toBeInTheDocument();
    expect(screen.getByText("azurerm_subnet.web")).toBeInTheDocument();
    expect(screen.getByText("azurerm_virtual_network.main")).toBeInTheDocument();
  });

  it("flies the camera to a resource when it is clicked", () => {
    const onSelectAddress = vi.fn();
    render(
      <RealityPanel
        result={reconciliation()}
        onSelectAddress={onSelectAddress}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "azurerm_storage_account.tmp" }),
    );
    expect(onSelectAddress).toHaveBeenCalledWith("azurerm_storage_account.tmp");
  });

  it("dates both sides, so the comparison is never read as live", () => {
    render(
      <RealityPanel
        result={reconciliation()}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/abcdef1/);
    expect(banner).toHaveTextContent(/1 hour ago/);
    expect(banner).not.toHaveTextContent(/live/i);
  });

  it("says an estate that matches its code matches it", () => {
    render(
      <RealityPanel
        result={reconciliation({
          counts: { unmanaged: 0, notApplied: 0, divergent: 0, matching: 6 },
          unmanaged: [],
          notApplied: [],
          divergent: [],
        })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/matches the code/i)).toBeInTheDocument();
  });

  it("omits a section that found nothing rather than printing an empty heading", () => {
    render(
      <RealityPanel
        result={reconciliation({
          counts: { unmanaged: 1, notApplied: 0, divergent: 0, matching: 4 },
          notApplied: [],
          divergent: [],
        })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/not managed by this repository/i)).toBeInTheDocument();
    expect(screen.queryByText(/declared but not found/i)).not.toBeInTheDocument();
  });

  it("closes", () => {
    const onClose = vi.fn();
    render(
      <RealityPanel
        result={reconciliation()}
        onSelectAddress={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /close reality panel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { baseElement } = render(
      <main>
        <RealityPanel
          result={reconciliation()}
          onSelectAddress={vi.fn()}
          onClose={vi.fn()}
        />
      </main>,
    );
    const results = await axe(baseElement);
    expect(results.violations).toEqual([]);
  });
});
