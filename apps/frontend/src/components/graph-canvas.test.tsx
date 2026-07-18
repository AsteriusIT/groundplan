import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// The instance handed to onInit — lets tests observe camera calls (GP-130).
const rfInstance = vi.hoisted(() => ({
  fitView: vi.fn(() => Promise.resolve(true)),
  setViewport: vi.fn(),
  getZoom: vi.fn(() => 1),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));

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
// onInit receives the shared rfInstance so camera behaviour is observable.
vi.mock("@xyflow/react", async () => {
  const { useEffect } = await import("react");
  return {
  ReactFlow: ({
    nodes,
    onInit,
    onNodeClick,
    onNodesChange,
    onPaneClick,
  }: {
    onInit?: (instance: typeof rfInstance) => void;
    // Loosened so annotation overlay nodes (which carry no real graphNode)
    // render without crashing; falls back to the node id for a label.
    nodes: {
      id: string;
      width?: number;
      height?: number;
      measured?: { width?: number; height?: number };
      data: {
        graphNode?: { name?: string };
        chips?: { id: string; name: string }[];
        highlightedChipId?: string;
        onSelectChip?: (chip: unknown) => void;
      };
    }[];
    onNodeClick?: (e: unknown, n: unknown) => void;
    onNodesChange?: (changes: { type: string; id: string; selected: boolean }[]) => void;
    onPaneClick?: () => void;
  }) => {
    // The real ReactFlow reports its instance once, after mount.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      onInit?.(rfInstance);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
    <div>
      <button type="button" data-testid="pane" onClick={() => onPaneClick?.()}>
        pane
      </button>
      {nodes.map((n) => (
        <span key={n.id} data-testid={`rf-node:${n.id}`} data-w={n.width} data-h={n.measured?.height}>
          <button type="button" onClick={(e) => onNodeClick?.(e, n)}>
            node:{n.data.graphNode?.name || n.id}
          </button>
          {/* Stand-in for a box/shift selection touching this node. */}
          <button
            type="button"
            data-testid={`rf-select:${n.id}`}
            onClick={() => onNodesChange?.([{ type: "select", id: n.id, selected: true }])}
          >
            select:{n.data.graphNode?.name || n.id}
          </button>
          {/* Stand-in for the chip row a container / card renders from data. */}
          {n.data.chips?.map((c) => (
            <button
              type="button"
              key={c.id}
              data-testid={`rf-chip:${c.id}`}
              data-lit={n.data.highlightedChipId === c.id ? "true" : "false"}
              onClick={() => n.data.onSelectChip?.(c)}
            >
              chip:{c.name}
            </button>
          ))}
        </span>
      ))}
    </div>
    );
  },
  Background: () => null,
  BackgroundVariant: { Dots: "dots", Lines: "lines", Cross: "cross" },
  SelectionMode: { Partial: "partial", Full: "full" },
  Controls: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  };
});

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

it("fits the view after layout; refits on a new graph, never on a re-render (GP-130)", async () => {
  const { rerender } = render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:main");
  await waitFor(() =>
    expect(rfInstance.fitView).toHaveBeenCalledWith({ padding: 0.1 }),
  );
  const fits = rfInstance.fitView.mock.calls.length;

  // Same graph re-rendered: no relayout, and the user's pan/zoom survives.
  rerender(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:main");
  expect(rfInstance.fitView.mock.calls.length).toBe(fits);

  // A changed graph lays out again — and frames itself again.
  const next: Graph = { ...graph, nodes: graph.nodes.slice(0, 2), edges: [] };
  rerender(<GraphCanvas graph={next} variant="plan" />);
  await waitFor(() =>
    expect(rfInstance.fitView.mock.calls.length).toBeGreaterThan(fits),
  );
});

/** The filter panel rests collapsed — open it before asserting on its contents. */
function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: /filters/i }));
}

it("rests with the filter panel collapsed, keeping the counter in view", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:main");

  // The panel holds canvas space open all session for something you touch once,
  // so it starts closed — but the count it exists to explain stays visible.
  expect(screen.getByText(/of 3 shown/)).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Create" })).not.toBeInTheDocument();

  openFilters();
  expect(screen.getByRole("checkbox", { name: /Create/ })).toBeInTheDocument();
});

it("shows change/impact filter checkboxes on the plan view", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  expect(await screen.findByText("node:main")).toBeInTheDocument();
  openFilters();
  for (const label of ["Create", "Update", "Delete", "No change", "Impacted"]) {
    expect(screen.getByRole("checkbox", { name: new RegExp(label) })).toBeChecked();
  }
});

it("toggles a filter checkbox", async () => {
  render(<GraphCanvas graph={graph} variant="plan" />);
  await screen.findByText("node:main");
  openFilters();
  const create = screen.getByRole("checkbox", { name: /Create/ });
  fireEvent.click(create);
  expect(create).not.toBeChecked();
});

it("shows category and module filters, a counter and reset (both variants)", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  openFilters();
  // Categories present in the graph.
  expect(screen.getByRole("checkbox", { name: /Network/ })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Compute/ })).toBeInTheDocument();
  // Module + root filters, derived from the snapshot's module nodes.
  expect(screen.getByRole("checkbox", { name: /^net/ })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /^root/ })).toBeInTheDocument();
  // Counter + reset.
  expect(screen.getByText(/of 3 shown/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
});

it("counts what each filter option covers, so unticking has a visible cost", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  openFilters();

  // One network resource (the vnet), one compute (the instance) — module nodes
  // are structure, not resources, and are never counted.
  expect(screen.getByRole("checkbox", { name: /Network\s*1/ })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Compute\s*1/ })).toBeInTheDocument();
});

it("explains what a line means, so the dashes are not a guess", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  expect(screen.getByText("depends_on")).toBeInTheDocument();
  expect(screen.getByText("inferred reference")).toBeInTheDocument();
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
  openFilters();
  const toggle = screen.getByRole("checkbox", { name: /show hub connections/i });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
});

it("hides the hub toggle when there are no hubs", async () => {
  render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  openFilters();
  expect(
    screen.queryByRole("checkbox", { name: /show hub connections/i }),
  ).not.toBeInTheDocument();
});

it("declares a size for every node, so hovering cannot blank the diagram", async () => {
  // React Flow hides a node it thinks is unmeasured, and it re-measures whenever
  // the node objects are rebuilt — which a hover does, for the whole graph. Every
  // node must therefore arrive with its size already declared, overlays included:
  // the annotation group frame and the note pin are nodes too.
  const annotation = (over: Record<string, unknown>) => ({
    id: "a",
    repositoryId: "r",
    type: "note" as const,
    anchors: ["aws_s3_bucket.data"],
    label: null,
    body: "b",
    status: "resolved" as const,
    provenance: "human" as const,
    reason: null,
    createdFromSha: null,
    parentGroupId: null,
    missingAnchors: [] as string[],
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotations={[
        annotation({ id: "n1" }),
        annotation({
          id: "g1",
          type: "group",
          label: "payments",
          anchors: ["aws_s3_bucket.data", "azurerm_virtual_network.main"],
        }),
      ]}
    />,
  );
  await screen.findByText("node:main");

  const nodes = screen.getAllByTestId(/^rf-node:/);
  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) {
    const id = node.getAttribute("data-testid");
    expect(Number(node.getAttribute("data-w")), `${id} declares a width`).toBeGreaterThan(0);
    expect(Number(node.getAttribute("data-h")), `${id} is measured`).toBeGreaterThan(0);
  }
});

// --- Annotate mode (GP-58) --------------------------------------------------

const NOTE = {
  id: "note-1",
  repositoryId: "r",
  type: "note" as const,
  anchors: ["aws_s3_bucket.data"],
  label: null,
  body: "owned by payments",
  status: "resolved" as const,
  provenance: "human" as const,
    reason: null,
  createdFromSha: null,
  parentGroupId: null,
  missingAnchors: [] as string[],
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

it("does not add tools or a note editor unless annotate is enabled", async () => {
  render(<GraphCanvas graph={graph} variant="docs" annotations={[]} />);
  await screen.findByText("node:main");
  expect(screen.queryByRole("button", { name: "Link" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("node:main"));
  expect(screen.queryByLabelText("New note")).not.toBeInTheDocument();
});

it("does not change the laid-out resource nodes when annotations are present", async () => {
  const { unmount } = render(<GraphCanvas graph={graph} variant="docs" />);
  await screen.findByText("node:main");
  const withoutAnn = screen
    .getAllByText(/^node:/)
    .map((el) => el.textContent)
    .sort();
  unmount();

  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[
        {
          ...NOTE,
          id: "link-1",
          type: "link",
          anchors: ["azurerm_virtual_network.main", "aws_s3_bucket.data"],
          body: null,
          label: "reads",
        },
      ]}
    />,
  );
  await screen.findByText("node:main");
  // The same resource/module nodes are laid out; only extra overlay (ann-*)
  // nodes appear — the generated layout is untouched.
  const resourceNodes = screen
    .getAllByText(/^node:/)
    .map((el) => el.textContent)
    .filter((t) => !t?.includes("ann-"))
    .sort();
  expect(resourceNodes).toEqual(withoutAnn);
});

it("creates a link by picking two nodes and labeling them", async () => {
  const onCreate = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[]}
      onCreateAnnotation={onCreate}
    />,
  );
  await screen.findByText("node:main");
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  fireEvent.click(screen.getByText("node:main"));
  fireEvent.click(screen.getByText("node:data"));
  fireEvent.change(screen.getByLabelText("Link label"), {
    target: { value: "replicates to" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add link" }));
  expect(onCreate).toHaveBeenCalledWith({
    type: "link",
    anchors: ["azurerm_virtual_network.main", "aws_s3_bucket.data"],
    label: "replicates to",
  });
});

it("creates a group from a box/multi selection", async () => {
  const onCreate = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[]}
      onCreateAnnotation={onCreate}
    />,
  );
  await screen.findByText("node:main");
  fireEvent.click(screen.getByRole("button", { name: "Group" }));
  // Prompt tells the user how to select.
  expect(screen.getByText(/drag a box/i)).toBeInTheDocument();
  // A selection box (or shift-click) touching two resources.
  fireEvent.click(screen.getByTestId("rf-select:azurerm_virtual_network.main"));
  fireEvent.click(screen.getByTestId("rf-select:aws_s3_bucket.data"));
  expect(screen.getByText(/2 selected/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Group label"), {
    target: { value: "data lake" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create group" }));
  expect(onCreate).toHaveBeenCalledWith({
    type: "group",
    anchors: ["azurerm_virtual_network.main", "aws_s3_bucket.data"],
    label: "data lake",
  });
});

it("ignores selection of non-resource nodes for grouping", async () => {
  render(<GraphCanvas graph={graph} variant="docs" annotate annotations={[]} />);
  await screen.findByText("node:main");
  fireEvent.click(screen.getByRole("button", { name: "Group" }));
  // module.net is a container node, not a groupable resource.
  fireEvent.click(screen.getByTestId("rf-select:module.net"));
  expect(screen.getByText(/drag a box/i)).toBeInTheDocument(); // still 0 selected
});

it("adds a note to a selected node in annotate mode", async () => {
  const onCreate = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[]}
      onCreateAnnotation={onCreate}
    />,
  );
  await screen.findByText("node:data");
  fireEvent.click(screen.getByText("node:data"));
  fireEvent.change(screen.getByLabelText("New note"), {
    target: { value: "holds raw events" },
  });
  fireEvent.click(screen.getByRole("button", { name: /add note/i }));
  expect(onCreate).toHaveBeenCalledWith({
    type: "note",
    anchors: ["aws_s3_bucket.data"],
    body: "holds raw events",
  });
});

it("shows existing notes read-only in view mode (no editor)", async () => {
  render(<GraphCanvas graph={graph} variant="docs" annotations={[NOTE]} />);
  fireEvent.click(await screen.findByText("node:data"));
  expect(screen.getByText(/owned by payments/)).toBeInTheDocument();
  expect(screen.queryByLabelText("New note")).not.toBeInTheDocument();
});

it("lists a link with a delete control in annotate mode", async () => {
  const onDelete = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[
        {
          ...NOTE,
          id: "link-1",
          type: "link",
          anchors: ["azurerm_virtual_network.main", "aws_s3_bucket.data"],
          body: null,
          label: "reads",
        },
      ]}
      onDeleteAnnotation={onDelete}
    />,
  );
  await screen.findByText("node:main");
  expect(screen.getByText("reads")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /delete annotation/i }));
  expect(onDelete).toHaveBeenCalledWith("link-1");
});

// --- Hide & rename (GP-73) --------------------------------------------------

it("hides a multi-selection as one annotation per resource", async () => {
  const onCreate = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[]}
      onCreateAnnotation={onCreate}
    />,
  );
  await screen.findByText("node:main");
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  fireEvent.click(screen.getByTestId("rf-select:azurerm_virtual_network.main"));
  fireEvent.click(screen.getByTestId("rf-select:aws_s3_bucket.data"));
  fireEvent.click(screen.getByRole("button", { name: "Hide 2" }));

  // One hide each, so a resource that later vanishes orphans only its own hide.
  expect(onCreate).toHaveBeenCalledTimes(2);
  expect(onCreate).toHaveBeenCalledWith({
    type: "hide",
    anchors: ["azurerm_virtual_network.main"],
  });
  expect(onCreate).toHaveBeenCalledWith({
    type: "hide",
    anchors: ["aws_s3_bucket.data"],
  });
});

it("renames a single resource", async () => {
  const onCreate = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[]}
      onCreateAnnotation={onCreate}
    />,
  );
  await screen.findByText("node:data");
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.click(screen.getByText("node:data"));
  fireEvent.change(screen.getByLabelText("New label"), {
    target: { value: "Event lake" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply rename" }));
  expect(onCreate).toHaveBeenCalledWith({
    type: "rename",
    anchors: ["aws_s3_bucket.data"],
    label: "Event lake",
  });
});

it("a logical edge may be drawn without a label", async () => {
  const onCreate = vi.fn();
  render(
    <GraphCanvas
      graph={graph}
      variant="docs"
      annotate
      annotations={[]}
      onCreateAnnotation={onCreate}
    />,
  );
  await screen.findByText("node:main");
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  fireEvent.click(screen.getByText("node:main"));
  fireEvent.click(screen.getByText("node:data"));
  fireEvent.click(screen.getByRole("button", { name: "Add link" }));
  expect(onCreate).toHaveBeenCalledWith({
    type: "link",
    anchors: ["azurerm_virtual_network.main", "aws_s3_bucket.data"],
  });
});

/**
 * A graph with no modules — every Kubernetes one, and any Terraform repository
 * that never wrote a module. The Module filter has nothing to offer it, but the
 * nodes must still be *shown*: the canvas seeds `activeModules` from the same
 * option list it renders the checkboxes from, so an option list that drops "root"
 * dims the whole diagram with no box left to bring it back (the "0 of 35 shown"
 * bug).
 */
const modulelessGraph: Graph = {
  version: 7,
  nodes: [
    {
      id: "Namespace/prod",
      name: "prod",
      type: "Namespace",
      provider: "kubernetes",
      module_path: [],
      change: null,
    },
    {
      id: "prod/Deployment/api",
      name: "api",
      type: "Deployment",
      provider: "kubernetes",
      module_path: [],
      change: null,
      parent_id: "Namespace/prod",
    },
  ],
  edges: [{ from: "Namespace/prod", to: "prod/Deployment/api", kind: "contains" }],
};

it("shows every node of a module-less graph, and offers no Module filter for it", async () => {
  render(<GraphCanvas graph={modulelessGraph} variant="docs" />);
  await screen.findByText("node:api");

  // The diagram is lit. Nothing is dimmed by a filter nobody can see. (The
  // namespace is a container, and containers are not counted as resources.)
  expect(screen.getByText(/1 of 1 shown/)).toBeInTheDocument();

  openFilters();
  expect(screen.queryByText("Module")).not.toBeInTheDocument();
});

// --- chip selection ring (network-schema-polish fix) --------------------------

const chipGraph: Graph = {
  version: 4,
  nodes: [
    { id: "vnet", name: "vnet", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
    { id: "subnet", name: "subnet", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null, parent_id: "vnet" },
    { id: "vm", name: "vm", type: "azurerm_linux_virtual_machine", provider: "azurerm", module_path: [], change: null, parent_id: "subnet" },
    { id: "nsg", name: "web-nsg", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null, associated_ids: ["subnet"] },
  ],
  edges: [
    { from: "vnet", to: "subnet", kind: "contains" },
    { from: "subnet", to: "vm", kind: "contains" },
  ],
};
const nsgNode = chipGraph.nodes[3]!;

it("a chip's ring follows the selection instead of sticking", async () => {
  render(
    <GraphCanvas
      graph={chipGraph}
      variant="docs"
      containerIds={new Set(["vnet", "subnet"])}
      chips={new Map([["subnet", [nsgNode]]])}
    />,
  );
  const chip = await screen.findByTestId("rf-chip:nsg");
  expect(chip.dataset.lit).toBe("false");

  // Clicking the chip selects its node: panel opens, ring lights.
  fireEvent.click(chip);
  expect(screen.getByTestId("rf-chip:nsg").dataset.lit).toBe("true");

  // Selecting something else moves the selection — the ring must follow it,
  // not stay burnt onto the chip.
  fireEvent.click(screen.getByText("node:vm"));
  expect(screen.getByTestId("rf-chip:nsg").dataset.lit).toBe("false");

  // And a pane click (deselect) leaves no ring anywhere.
  fireEvent.click(chip);
  expect(screen.getByTestId("rf-chip:nsg").dataset.lit).toBe("true");
  fireEvent.click(screen.getByTestId("pane"));
  expect(screen.getByTestId("rf-chip:nsg").dataset.lit).toBe("false");
});
