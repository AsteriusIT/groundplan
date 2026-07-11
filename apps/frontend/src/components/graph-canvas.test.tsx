import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Mock ELK: return the input graph with trivial positions so elkToFlow works.
vi.mock("elkjs/lib/elk.bundled.js", () => {
  type Elkish = {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    children?: Elkish[];
  };
  const place = (n: Elkish): Elkish => ({
    ...n,
    x: 0,
    y: 0,
    width: n.width ?? 200,
    height: n.height ?? 56,
    children: n.children?.map(place),
  });
  return {
    default: class {
      layout(graph: Elkish) {
        return Promise.resolve(place(graph));
      }
    },
  };
});

// Mock React Flow: render each node as a button wired to onNodeClick, plus a
// pane target for onPaneClick. Node internals are covered by graph-layout tests.
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    onNodeClick,
    onPaneClick,
  }: {
    nodes: { id: string; data: { graphNode: { name: string } } }[];
    onNodeClick?: (e: unknown, n: unknown) => void;
    onPaneClick?: () => void;
  }) => (
    <div>
      <button type="button" data-testid="pane" onClick={() => onPaneClick?.()}>
        pane
      </button>
      {nodes.map((n) => (
        <button key={n.id} type="button" onClick={(e) => onNodeClick?.(e, n)}>
          node:{n.data.graphNode.name}
        </button>
      ))}
    </div>
  ),
  Background: () => null,
  BackgroundVariant: { Dots: "dots", Lines: "lines", Cross: "cross" },
  Controls: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

vi.mock("@xyflow/react/dist/style.css", () => ({}));

import type { Graph } from "@/api/types";
import { GraphCanvas } from "./graph-canvas";

const graph: Graph = {
  version: 2,
  nodes: [
    { id: "azurerm_virtual_network.main", name: "main", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: "create" },
    { id: "aws_s3_bucket.data", name: "data", type: "aws_s3_bucket", provider: "aws", module_path: [], change: "noop", impacted: true, impact_distance: 2 },
    { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
    { id: "module.net.aws_instance.web", name: "web", type: "aws_instance", provider: "aws", module_path: ["net"], change: "create" },
  ],
  edges: [{ from: "module.net", to: "module.net.aws_instance.web", kind: "contains" }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows change/impact filter checkboxes on the plan view", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  expect(await screen.findByText("node:main")).toBeInTheDocument();
  for (const label of ["Create", "Update", "Delete", "No change", "Impacted"]) {
    expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
  }
});

it("toggles a filter checkbox", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:main");
  const create = screen.getByRole("checkbox", { name: "Create" });
  fireEvent.click(create);
  expect(create).not.toBeChecked();
});

it("shows category and module filters, a counter and reset (both variants)", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  // Categories present in the graph.
  expect(screen.getByRole("checkbox", { name: /Network/ })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Compute/ })).toBeInTheDocument();
  // Module + root filters, derived from the snapshot's module nodes.
  expect(screen.getByRole("checkbox", { name: "net" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "root" })).toBeInTheDocument();
  // Counter + reset.
  expect(screen.getByText(/of 3 shown/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
});

it("opens the details panel on node click and closes it on pane click", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  fireEvent.click(await screen.findByText("node:main"));
  expect(screen.getByText("Terraform address")).toBeInTheDocument();
  expect(screen.getByText("azurerm_virtual_network.main")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("pane"));
  expect(screen.queryByText("Terraform address")).not.toBeInTheDocument();
});

it("shows the impact chip in the panel for an impacted node", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  fireEvent.click(await screen.findByText("node:data"));
  expect(screen.getByText(/impacted · d2/)).toBeInTheDocument();
});

it("'/' focuses the search box; searching + Enter flies to and selects a node", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:main");
  const search = screen.getByLabelText("Search resources");

  fireEvent.keyDown(document.body, { key: "/" });
  expect(search).toHaveFocus();

  // "vnet" fuzzily matches azurerm_virtual_network; Enter selects the first hit.
  fireEvent.change(search, { target: { value: "vnet" } });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(screen.getByText("Terraform address")).toBeInTheDocument();
  expect(screen.getByText("azurerm_virtual_network.main")).toBeInTheDocument();
});

it("hides the change filters on the docs variant", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  expect(screen.queryByRole("checkbox", { name: "Create" })).not.toBeInTheDocument();
});

// --- Hub-edge taming (GP-35) ------------------------------------------------

const hubGraph: Graph = {
  version: 1,
  nodes: [
    { id: "rg", name: "rg", type: "azurerm_resource_group", provider: "azurerm", module_path: [], change: null },
    { id: "vm", name: "vm", type: "azurerm_linux_virtual_machine", provider: "azurerm", module_path: [], change: null },
  ],
  edges: [{ from: "vm", to: "rg", kind: "depends_on" }],
};

it("offers a 'Show hub connections' toggle only when hubs are present", async () => {
  render(<GraphCanvas graph={hubGraph} variant="docs" />);
  await screen.findByText("node:rg");
  const toggle = screen.getByRole("checkbox", { name: /show hub connections/i });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
});

it("hides the hub toggle when there are no hubs", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  expect(
    screen.queryByRole("checkbox", { name: /show hub connections/i }),
  ).not.toBeInTheDocument();
});
