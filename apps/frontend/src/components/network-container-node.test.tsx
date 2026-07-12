import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { GraphNode } from "@/api/types";
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
