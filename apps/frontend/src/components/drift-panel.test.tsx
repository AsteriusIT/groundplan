import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { DriftState, DriftedResource } from "@/api/types";
import { DriftPanel } from "./drift-panel";

const resource = (
  address: string,
  over: Partial<DriftedResource> = {},
): DriftedResource => ({
  address,
  type: "azurerm_storage_account",
  provider: "azurerm",
  module_path: [],
  change: "update",
  attribute_diff: [
    { key: "min_tls_version", before: "TLS1_2", after: "TLS1_0" },
  ],
  ...over,
});

const state = (over: Partial<DriftState> = {}): DriftState => ({
  id: "d1",
  repositoryId: "r1",
  ref: "main",
  commitSha: "aaaaaaaaaaaa",
  snapshotId: "s1",
  baseCommitSha: "aaaaaaaaaaaa",
  stale: false,
  measuredAt: new Date(Date.now() - 3_600_000).toISOString(),
  report: {
    version: 1,
    counts: { updated: 1, deleted: 0, total: 1 },
    resources: [resource("azurerm_storage_account.data")],
  },
  summaryMd: "",
  ...over,
});

describe("DriftPanel (GP-207)", () => {
  it("lists what drifted, with the attributes that moved", () => {
    render(<DriftPanel drift={state()} onSelectAddress={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText("azurerm_storage_account.data")).toBeInTheDocument();
    expect(screen.getByText("min_tls_version")).toBeInTheDocument();
    expect(screen.getByText("TLS1_2")).toBeInTheDocument();
    expect(screen.getByText("TLS1_0")).toBeInTheDocument();
  });

  it("flies the camera to a resource when it is clicked", () => {
    const onSelectAddress = vi.fn();
    render(
      <DriftPanel drift={state()} onSelectAddress={onSelectAddress} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /azurerm_storage_account.data/ }));
    expect(onSelectAddress).toHaveBeenCalledWith("azurerm_storage_account.data");
  });

  it("says when the estate was measured, and against which commit", () => {
    render(<DriftPanel drift={state()} onSelectAddress={vi.fn()} onClose={vi.fn()} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/1 hour ago/);
    expect(banner).toHaveTextContent(/aaaaaaa/);
  });

  it("warns that a stale measurement must be re-run before it is acted on", () => {
    render(
      <DriftPanel
        drift={state({ stale: true, baseCommitSha: "bbbbbbbbbbbb" })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/re-measure/i);
    expect(banner).toHaveTextContent(/bbbbbbb/);
  });

  it("a stale measurement lists nothing — it is about a commit nobody is viewing", () => {
    render(
      <DriftPanel
        drift={state({ stale: true, baseCommitSha: "bbbbbbbbbbbb" })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByText("azurerm_storage_account.data"),
    ).not.toBeInTheDocument();
  });

  it("says the estate matches rather than showing an empty list", () => {
    render(
      <DriftPanel
        drift={state({
          report: { version: 1, counts: { updated: 0, deleted: 0, total: 0 }, resources: [] },
        })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/matches the code/i)).toBeInTheDocument();
  });

  it("calls a resource deleted outside Terraform what it is", () => {
    render(
      <DriftPanel
        drift={state({
          report: {
            version: 1,
            counts: { updated: 0, deleted: 1, total: 1 },
            resources: [
              resource("aws_s3_bucket.logs", { change: "delete", attribute_diff: [] }),
            ],
          },
        })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
  });

  it("separates a violation introduced outside IaC from the rest", () => {
    render(
      <DriftPanel
        drift={state({
          report: {
            version: 2,
            counts: { updated: 1, deleted: 0, total: 1 },
            resources: [resource("azurerm_network_security_group.web")],
            policy: {
              version: 1,
              added: [
                {
                  ruleId: "nsg-open-to-internet",
                  severity: "error",
                  address: "azurerm_network_security_group.web",
                  message: "This NSG has an inbound Allow rule open to the internet.",
                  hint: "Restrict source_address_prefix.",
                },
              ],
              resolved: [],
              preexisting: [],
              status: "failing",
              baseSnapshotId: "s1",
            },
          },
        })}
        onSelectAddress={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/introduced outside/i)).toBeInTheDocument();
    expect(screen.getByText(/inbound Allow rule open to the internet/)).toBeInTheDocument();
    expect(screen.getByText("nsg-open-to-internet")).toBeInTheDocument();
  });

  it("says nothing about compliance when the engine could not compare", () => {
    render(<DriftPanel drift={state()} onSelectAddress={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText(/introduced outside/i)).not.toBeInTheDocument();
  });

  it("closes", () => {
    const onClose = vi.fn();
    render(<DriftPanel drift={state()} onSelectAddress={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close drift panel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { baseElement } = render(
      <main>
        <DriftPanel drift={state()} onSelectAddress={vi.fn()} onClose={vi.fn()} />
      </main>,
    );
    const results = await axe(baseElement);
    expect(results.violations).toEqual([]);
  });
});
