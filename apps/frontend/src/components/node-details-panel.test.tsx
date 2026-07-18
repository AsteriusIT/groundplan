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

it("renders a Security rules section for an NSG, flagging internet rows (GP-45)", () => {
  const nsg: GraphNode = {
    id: "azurerm_network_security_group.open",
    name: "open",
    type: "azurerm_network_security_group",
    provider: "azurerm",
    module_path: [],
    change: null,
    rules: [
      { name: "allow-internal", priority: 200, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "22", source: "10.0.0.0/8", destination: "*" },
      { name: "allow-https", priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", ports: "443", source: "Internet", destination: "*" },
    ],
  };
  const graph: Graph = { version: 4, nodes: [nsg], edges: [] };
  render(<NodeDetailsPanel graph={graph} node={nsg} onClose={() => {}} onSelect={() => {}} />);

  expect(screen.getByText("Security rules")).toBeInTheDocument();
  // Sorted by priority: allow-https (100) appears before allow-internal (200).
  const names = screen.getAllByText(/allow-(https|internal)/).map((n) => n.textContent);
  expect(names).toEqual(["allow-https", "allow-internal"]);
  // Exactly one row is flagged as an internet source.
  expect(screen.getAllByLabelText(/internet source/i)).toHaveLength(1);
});

it("hides the Security rules section when a node has no rules", () => {
  const graph: Graph = { version: 4, nodes: [subnet], edges: [] };
  render(<NodeDetailsPanel graph={graph} node={subnet} onClose={() => {}} onSelect={() => {}} />);
  expect(screen.queryByText("Security rules")).not.toBeInTheDocument();
});

// --- Source section (GP-121) ------------------------------------------------

const HCL = [
  'resource "azurerm_subnet" "internal" {',
  '  name             = "internal"   # the app tier',
  '  address_prefixes = ["10.0.1.0/24"]',
  "}",
].join("\n");

const sourced: GraphNode = {
  ...subnet,
  source: {
    file: "modules/network/main.tf",
    start_line: 12,
    end_line: 15,
    code: HCL,
  },
};

it("shows the file, the line range and the block's code (GP-121)", () => {
  const graph: Graph = { version: 8, nodes: [sourced], edges: [] };
  render(
    <NodeDetailsPanel
      graph={graph}
      node={sourced}
      onClose={() => {}}
      onSelect={() => {}}
      showChange={false}
    />,
  );

  expect(screen.getByText("Source")).toBeInTheDocument();
  expect(screen.getByText(/modules\/network\/main\.tf · L12–L15/)).toBeInTheDocument();
  // Highlighting splits the block across spans; the rendered text must still be
  // the file's text, byte for byte — a snippet that differs is worse than none.
  const code = document.querySelector("pre code");
  expect(code?.textContent).toBe(HCL);
});

it("copies the raw source, not the highlighted markup (GP-121)", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  const graph: Graph = { version: 8, nodes: [sourced], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={sourced} onClose={() => {}} onSelect={() => {}} />,
  );

  fireEvent.click(screen.getByLabelText("Copy source"));
  expect(writeText).toHaveBeenCalledWith(HCL);
  // The button sits in the <summary>; copying must not collapse the section out
  // from under the reader. Browsers skip summary's toggle for an interactive
  // descendant — this pins that, since the layout depends on it.
  expect(document.querySelector("details")?.open).toBe(true);
});

it("renders a single-line block's span without a range (GP-121)", () => {
  const oneLiner: GraphNode = {
    ...subnet,
    source: { file: "main.tf", start_line: 7, end_line: 7, code: 'data "aws_x" "y" {}' },
  };
  const graph: Graph = { version: 8, nodes: [oneLiner], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={oneLiner} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.getByText(/main\.tf · L7$/)).toBeInTheDocument();
});

it("omits the Source section when a node has no source (plan flow, GP-121)", () => {
  const graph: Graph = { version: 3, nodes: [shopDb], edges: [] };
  render(
    <NodeDetailsPanel graph={graph} node={shopDb} onClose={() => {}} onSelect={() => {}} />,
  );
  expect(screen.queryByText("Source")).not.toBeInTheDocument();
  expect(document.querySelector("pre")).toBeNull();
});
