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
  version: 1,
  nodes: [
    { id: "aws_s3.a", name: "alpha", type: "aws_s3", provider: "aws", module_path: [], change: "create" },
    { id: "aws_s3.b", name: "beta", type: "aws_s3", provider: "aws", module_path: [], change: "noop" },
  ],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows the legend and a changes-only toggle on the plan view", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  expect(await screen.findByText("node:alpha")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /changes only/i }),
  ).toHaveAttribute("aria-pressed", "false");
  // Legend colour key entries.
  expect(screen.getByText("Create")).toBeInTheDocument();
  expect(screen.getByText("Delete")).toBeInTheDocument();
});

it("toggles the changes-only filter", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:alpha");
  const toggle = screen.getByRole("button", { name: /changes only/i });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
});

it("opens the details panel on node click and closes it on pane click", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  fireEvent.click(await screen.findByText("node:alpha"));

  // Panel shows fields drawn only from the snapshot node.
  expect(screen.getByText("Address")).toBeInTheDocument();
  expect(screen.getByText("aws_s3.a")).toBeInTheDocument();

  fireEvent.click(screen.getByTestId("pane"));
  expect(screen.queryByText("Address")).not.toBeInTheDocument();
});

it("hides the change legend and filter on the docs variant", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:alpha");
  expect(
    screen.queryByRole("button", { name: /changes only/i }),
  ).not.toBeInTheDocument();
});
