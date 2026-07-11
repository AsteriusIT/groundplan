import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { Graph, GraphNode } from "@/api/types";
import { NodeDetailsPanel } from "./node-details-panel";

const vnet: GraphNode = {
  id: "azurerm_virtual_network.main",
  name: "main",
  type: "azurerm_virtual_network",
  provider: "azurerm",
  module_path: [],
  change: "update",
};
const subnet: GraphNode = {
  id: "azurerm_subnet.internal",
  name: "internal",
  type: "azurerm_subnet",
  provider: "azurerm",
  module_path: [],
  change: "noop",
  impacted: true,
  impact_distance: 1,
};
const shopDb: GraphNode = {
  id: "azurerm_mssql_database.shop_db",
  name: "shop_db",
  type: "azurerm_mssql_database",
  provider: "azurerm",
  module_path: [],
  change: "update",
  attribute_diff: [
    { key: "sku_name", before: "S0", after: "P1" },
    { key: "administrator_login_password", before: "(sensitive)", after: "(sensitive)" },
    { key: "primary_key", before: null, after: "(known after apply)" },
  ],
};

const graph: Graph = {
  version: 3,
  nodes: [vnet, subnet, shopDb],
  edges: [
    { from: "azurerm_subnet.internal", to: "azurerm_virtual_network.main", kind: "depends_on" },
  ],
};

it("renders the attribute diff with values and masks sensitive ones (GP-32/33)", () => {
  render(
    <NodeDetailsPanel graph={graph} node={shopDb} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.getByText(/^Changes/)).toBeInTheDocument();
  expect(screen.getByText("sku_name")).toBeInTheDocument();
  expect(screen.getByText("S0")).toBeInTheDocument();
  expect(screen.getByText("P1")).toBeInTheDocument();
  // Sensitive value is masked on both sides; known-after-apply rendered as such.
  expect(screen.getAllByText("(sensitive)")).toHaveLength(2);
  expect(screen.getByText("(known after apply)")).toBeInTheDocument();
});

it("shows the why-impacted sentence and navigates to the changed ancestor", () => {
  const onSelect = vi.fn();
  render(
    <NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={onSelect} />,
  );
  expect(screen.getByText(/Why impacted/i)).toBeInTheDocument();
  // The sentence names the changed ancestor; clicking it selects that node.
  const why = screen.getByText(/This unchanged resource is impacted/i);
  fireEvent.click(within(why).getByRole("button", { name: "virtual_network.main" }));
  expect(onSelect).toHaveBeenCalledWith(vnet);
});

it("lists connections and navigates on click", () => {
  const onSelect = vi.fn();
  render(
    <NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={onSelect} />,
  );
  const dependsOn = screen.getByText("Depends on").parentElement as HTMLElement;
  fireEvent.click(within(dependsOn).getByText("virtual_network.main"));
  expect(onSelect).toHaveBeenCalledWith(vnet);
});

it("renders old snapshots (no attribute_diff) without a Changes section", () => {
  const legacy: GraphNode = {
    id: "aws_s3_bucket.logs",
    name: "logs",
    type: "aws_s3_bucket",
    provider: "aws",
    module_path: [],
    change: "noop",
  };
  const legacyGraph: Graph = { version: 2, nodes: [legacy], edges: [] };
  render(
    <NodeDetailsPanel graph={legacyGraph} node={legacy} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.queryByText(/^Changes/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Why impacted/i)).not.toBeInTheDocument();
  // Address section still renders.
  expect(screen.getByText("Terraform address")).toBeInTheDocument();
  expect(screen.getByText("aws_s3_bucket.logs")).toBeInTheDocument();
});
