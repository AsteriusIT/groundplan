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
    { id: "aws_s3.a", name: "alpha", type: "aws_s3", provider: "aws", module_path: [], change: "create" },
    { id: "aws_s3.b", name: "beta", type: "aws_s3", provider: "aws", module_path: [], change: "noop", impacted: true, impact_distance: 2 },
  ],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows change/impact filter checkboxes on the plan view", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  expect(await screen.findByText("node:alpha")).toBeInTheDocument();
  for (const label of ["Create", "Update", "Delete", "No change", "Impacted"]) {
    expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
  }
});

it("toggles a filter checkbox", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:alpha");
  const create = screen.getByRole("checkbox", { name: "Create" });
  fireEvent.click(create);
  expect(create).not.toBeChecked();
});

it("opens the details panel on node click and closes it on pane click", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  fireEvent.click(await screen.findByText("node:alpha"));

  // Panel shows fields drawn only from the snapshot node (full type).
  expect(screen.getByText("Address")).toBeInTheDocument();
  expect(screen.getByText("aws_s3.a")).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("pane"));
  expect(screen.queryByText("Address")).not.toBeInTheDocument();
});

it("shows the impact chip in the panel for an impacted node", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  fireEvent.click(await screen.findByText("node:beta"));
  expect(screen.getByText(/impacted · distance 2/)).toBeInTheDocument();
});

it("hides the change filters on the docs variant", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:alpha");
  expect(screen.queryByRole("checkbox", { name: "Create" })).not.toBeInTheDocument();
});
