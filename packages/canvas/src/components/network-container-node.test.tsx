import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { GraphNode } from "../types";
import { NetworkContainer } from "./network-container-node";

const subnet: GraphNode = {
  id: "sn",
  name: "internal",
  type: "azurerm_subnet",
  provider: "azurerm",
  module_path: [],
  change: null,
};

const vnet: GraphNode = {
  id: "vn",
  name: "prod",
  type: "azurerm_virtual_network",
  provider: "azurerm",
  module_path: [],
  change: null,
};

it("labels a subnet container with its 'subnet' layer + name", () => {
  render(<NetworkContainer graphNode={subnet} />);
  expect(screen.getByText("internal")).toBeInTheDocument(); // name
  expect(screen.getByText("subnet")).toBeInTheDocument(); // layer label
});

it("labels a vnet container with its 'vnet' layer + name", () => {
  render(<NetworkContainer graphNode={vnet} />);
  expect(screen.getByText("prod")).toBeInTheDocument(); // name
  expect(screen.getByText("vnet")).toBeInTheDocument(); // layer label (not "virtual_network")
});

// --- Subnet chips (GP-89) ----------------------------------------------------

const nsg = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: "nsg",
  name: "web-nsg",
  type: "azurerm_network_security_group",
  provider: "azurerm",
  module_path: [],
  change: null,
  ...over,
});

it("renders an attached NSG / route table as a chip on the subnet header", () => {
  render(
    <NetworkContainer
      graphNode={subnet}
      chips={[
        nsg({ change: "update" }),
        { ...nsg(), id: "rt", name: "rt", type: "azurerm_route_table" },
      ]}
    />,
  );
  expect(screen.getByText("web-nsg")).toBeInTheDocument();
  expect(screen.getByText("rt")).toBeInTheDocument();
});

it("selects the chip's node when the chip is clicked", () => {
  const onSelect = vi.fn();
  const node = nsg();
  render(<NetworkContainer graphNode={subnet} chips={[node]} onSelectChip={onSelect} />);
  fireEvent.click(screen.getByText("web-nsg"));
  expect(onSelect).toHaveBeenCalledWith(node);
});

it("renders no chip row when the subnet has no attachments", () => {
  const { container } = render(<NetworkContainer graphNode={subnet} />);
  expect(container.querySelector("[data-subnet-chip]")).toBeFalsy();
});

it("a subnet header with chips is accessible", async () => {
  const { baseElement } = render(
    <main>
      <NetworkContainer graphNode={subnet} chips={[nsg({ internet_exposed: true })]} />
    </main>,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});

it("shows the subnet CIDR on the frame header", () => {
  render(
    <NetworkContainer
      graphNode={{ ...subnet, attributes: { address_prefixes: "10.0.2.0/24" } }}
    />,
  );
  expect(screen.getByText("10.0.2.0/24")).toBeInTheDocument();
});

it("shows the vnet address space on the frame header", () => {
  render(
    <NetworkContainer
      graphNode={{ ...vnet, attributes: { address_space: "10.0.0.0/16" } }}
    />,
  );
  expect(screen.getByText("10.0.0.0/16")).toBeInTheDocument();
});

it("a highlighted chip wears a tight 1px ring — no fat offset halo on a small pill", () => {
  render(
    <NetworkContainer graphNode={subnet} chips={[nsg()]} highlightedChipId="nsg" />,
  );
  const btn = screen.getByTitle("azurerm_network_security_group · web-nsg");
  expect(btn.className).toContain("ring-1");
  expect(btn.className).not.toContain("ring-2");
  expect(btn.className).not.toContain("ring-offset");
  // The button must shrink-wrap the pill — inline content would sit on a text
  // baseline and the ring would paint taller and wider than the pill itself.
  expect(btn.className).toContain("inline-flex");
});
