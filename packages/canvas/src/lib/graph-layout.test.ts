import { describe, expect, it } from "vitest";

import type { Graph, GraphEdge } from "../types";
import {
  ALL_FILTERS,
  categoryCounts,
  changeClasses,
  depEdgeId,
  ELK_ROOT_OPTIONS,
  elkToFlow,
  moduleCounts,
  moduleOptions,
  categoryOptions,
  exposedNodeIds,
  neighborhood,
  networkProjection,
  nodePassesFilters,
  reanchorStackEdges,
  resourceStacks,
  toElkGraph,
  type ElkGraphNode,
} from "./graph-layout";
import { detectHubs } from "../lib/hub";

const allFilters = new Set(ALL_FILTERS);

const graph: Graph = {
  version: 1,
  nodes: [
    { id: "aws_s3.a", name: "a", type: "aws_s3", provider: "aws", module_path: [], change: "create" },
    { id: "aws_s3.b", name: "b", type: "aws_s3", provider: "aws", module_path: [], change: "noop" },
    { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
    { id: "module.net.aws_vpc.v", name: "v", type: "aws_vpc", provider: "aws", module_path: ["net"], change: "update" },
    { id: "module.empty", name: "empty", type: "module", provider: null, module_path: [], change: null },
  ],
  edges: [
    { from: "module.net", to: "module.net.aws_vpc.v", kind: "contains" },
    { from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" },
  ],
};

it("toElkGraph nests contained nodes and keeps only depends_on as edges", () => {
  const elk = toElkGraph(graph);
  const module = elk.children?.find((c) => c.id === "module.net");
  expect(module?.children?.map((c) => c.id)).toEqual(["module.net.aws_vpc.v"]);
  // The nested resource is not also a root.
  expect(elk.children?.some((c) => c.id === "module.net.aws_vpc.v")).toBe(false);
  // Only the depends_on edge becomes an ELK edge (contains → nesting), reversed
  // into impact-flow direction (dependency → dependent) so roots land left.
  expect(elk.edges).toHaveLength(1);
  expect(elk.edges?.[0]).toMatchObject({
    sources: ["aws_s3.b"],
    targets: ["aws_s3.a"],
  });
});

it("toElkGraph turns a childless module into a sized leaf node", () => {
  const elk = toElkGraph(graph);
  const empty = elk.children?.find((c) => c.id === "module.empty");
  expect(empty?.children).toBeUndefined();
  expect(empty?.width).toBeGreaterThan(0);
});

it("elkToFlow yields nested React Flow nodes with positions and edges", () => {
  // A hand-laid-out ELK result (positions already assigned).
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 300, y: 0, width: 220, height: 56 },
      {
        id: "module.net",
        x: 0,
        y: 120,
        width: 260,
        height: 120,
        children: [{ id: "module.net.aws_vpc.v", x: 16, y: 36, width: 220, height: 56 }],
      },
      { id: "module.empty", x: 600, y: 0, width: 200, height: 56 },
    ],
  };

  const { nodes, edges } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });

  const vpc = nodes.find((n) => n.id === "module.net.aws_vpc.v");
  expect(vpc?.parentId).toBe("module.net");
  expect(vpc?.position).toEqual({ x: 16, y: 36 });

  const module = nodes.find((n) => n.id === "module.net");
  expect(module?.type).toBe("module");
  // Parent appears before its child (React Flow requirement).
  expect(nodes.findIndex((n) => n.id === "module.net")).toBeLessThan(
    nodes.findIndex((n) => n.id === "module.net.aws_vpc.v"),
  );

  // With all filters on and no selection, nothing is dimmed.
  expect(nodes.every((n) => n.data.dimmed === false)).toBe(true);

  // Drawn in impact-flow direction (dependency → dependent).
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ source: "aws_s3.b", target: "aws_s3.a" });
});

it("nodePassesFilters gates resources by change; modules & docs nodes always pass", () => {
  const node = (over: Partial<Graph["nodes"][number]>) => ({
    id: "x", name: "x", type: "aws_s3", provider: "aws", module_path: [], change: null, ...over,
  });
  expect(nodePassesFilters(node({ change: "create" }), new Set(["create"]))).toBe(true);
  expect(nodePassesFilters(node({ change: "create" }), new Set(["delete"]))).toBe(false);
  // Impacted noop shows when the impacted filter is on, even if noop is off.
  expect(
    nodePassesFilters(node({ change: "noop", impacted: true }), new Set(["impacted"])),
  ).toBe(true);
  // Module and docs (null change) resources always pass.
  expect(nodePassesFilters(node({ type: "module" }), new Set())).toBe(true);
  expect(nodePassesFilters(node({ change: null }), new Set())).toBe(true);
});

it("neighborhood is the selected node plus its edge neighbours", () => {
  const near = neighborhood(graph, "aws_s3.a");
  expect([...near].sort()).toEqual(["aws_s3.a", "aws_s3.b"]);
});

it("a selection dims everything outside its neighbourhood", () => {
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 300, y: 0, width: 220, height: 56 },
      { id: "module.empty", x: 600, y: 0, width: 200, height: 56 },
    ],
  };
  const { nodes } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: "aws_s3.a",
  });
  expect(nodes.find((n) => n.id === "aws_s3.a")?.data.dimmed).toBe(false);
  expect(nodes.find((n) => n.id === "aws_s3.b")?.data.dimmed).toBe(false); // neighbour
  // module.empty is unrelated but modules are never dimmed.
  expect(nodes.find((n) => n.id === "module.empty")?.data.dimmed).toBe(false);
});

it("filtering out a change dims those resources", () => {
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 300, y: 0, width: 220, height: 56 },
    ],
  };
  // create off → aws_s3.a (create) dimmed; aws_s3.b (noop) still shown.
  const { nodes } = elkToFlow(layout, graph, {
    activeFilters: new Set(["update", "delete", "noop", "impacted"]),
    selectedId: null,
  });
  expect(nodes.find((n) => n.id === "aws_s3.a")?.data.dimmed).toBe(true);
  expect(nodes.find((n) => n.id === "aws_s3.b")?.data.dimmed).toBe(false);
});

it("changeClasses marks deletes as dashed and destructive", () => {
  expect(changeClasses("delete")).toMatch(/dashed/);
  expect(changeClasses("create")).toMatch(/create/);
  expect(changeClasses(null)).toMatch(/border-border/);
});

// --- Hub-edge taming (GP-35) ------------------------------------------------

const hubGraph: Graph = {
  version: 1,
  nodes: [
    { id: "rg", name: "rg", type: "azurerm_resource_group", provider: "azurerm", module_path: [], change: null },
    { id: "vm", name: "vm", type: "azurerm_linux_virtual_machine", provider: "azurerm", module_path: [], change: null },
    { id: "subnet", name: "subnet", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
  ],
  edges: [
    { from: "vm", to: "rg", kind: "depends_on" }, // hub edge (rg is a hub)
    { from: "subnet", to: "rg", kind: "depends_on" }, // hub edge
    { from: "vm", to: "subnet", kind: "depends_on" }, // plain edge
  ],
};
const hubs = new Set(["rg"]);
const flatLayout: ElkGraphNode = {
  id: "root",
  children: [
    { id: "rg", x: 0, y: 0, width: 220, height: 56 },
    { id: "vm", x: 300, y: 0, width: 220, height: 56 },
    { id: "subnet", x: 600, y: 0, width: 220, height: 56 },
  ],
};

it("toElkGraph omits hub edges from the layout", () => {
  const elk = toElkGraph(hubGraph, hubs);
  // Only the vm→subnet plain edge survives for layout.
  expect(elk.edges).toHaveLength(1);
});

it("elkToFlow hides hub edges by default and counts them on the hub", () => {
  const { edges, nodes } = elkToFlow(flatLayout, hubGraph, {
    activeFilters: allFilters,
    selectedId: null,
    hubs,
  });
  // Only the plain vm→subnet edge is drawn.
  expect(edges).toHaveLength(1);
  const rg = nodes.find((n) => n.id === "rg");
  expect(rg?.data.isHub).toBe(true);
  expect(rg?.data.hubHiddenCount).toBe(2); // both rg edges hidden
});

it("selecting a node reveals its edge to the hub", () => {
  const { edges } = elkToFlow(flatLayout, hubGraph, {
    activeFilters: allFilters,
    selectedId: "vm",
    hubs,
  });
  // vm→rg (revealed by selection) + vm→subnet = 2. subnet→rg stays hidden.
  const ids = edges.map((e) => `${e.source}->${e.target}`).sort();
  expect(ids).toContain("rg->vm"); // drawn dependency→dependent direction
});

it("the toggle reveals every hub edge", () => {
  const { edges, nodes } = elkToFlow(flatLayout, hubGraph, {
    activeFilters: allFilters,
    selectedId: null,
    hubs,
    showHubEdges: true,
  });
  expect(edges).toHaveLength(3); // all edges drawn
  expect(nodes.find((n) => n.id === "rg")?.data.hubHiddenCount).toBe(0);
});

const netGraph: Graph = {
  version: 4,
  nodes: [
    { id: "vn", name: "vn", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
    { id: "sn", name: "sn", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null, parent_id: "vn" },
    { id: "nic", name: "nic", type: "azurerm_network_interface", provider: "azurerm", module_path: [], change: null, parent_id: "sn" },
    { id: "nsg", name: "nsg", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null, associated_ids: ["sn"] },
    { id: "assoc", name: "assoc", type: "azurerm_subnet_network_security_group_association", provider: "azurerm", module_path: [], change: null, parent_id: "sn" },
    { id: "db", name: "db", type: "azurerm_mssql_server", provider: "azurerm", module_path: [], change: null },
  ],
  edges: [{ from: "vn", to: "sn", kind: "contains" }],
};

it("networkProjection keeps the containment chain + associated NSG, drops the rest", () => {
  const { graph: projected, hiddenCount } = networkProjection(netGraph);
  const ids = projected.nodes.map((n) => n.id).sort();
  // db dropped; the *_association plumbing node dropped (not counted).
  expect(ids).toEqual(["nic", "nsg", "sn", "vn"]);
  expect(hiddenCount).toBe(1); // db only — plumbing isn't a "hidden resource"
  // containment re-expressed as contains edges for the subflow layout
  expect(projected.edges).toContainEqual({ from: "vn", to: "sn", kind: "contains" });
  expect(projected.edges).toContainEqual({ from: "sn", to: "nic", kind: "contains" });
});

it("networkProjection re-nests vnet/subnet as containers via toElkGraph", () => {
  const { graph: projected } = networkProjection(netGraph);
  const elk = toElkGraph(projected);
  // vn is a root container holding sn; sn holds nic.
  const vn = elk.children?.find((c) => c.id === "vn");
  expect(vn?.children?.map((c) => c.id)).toContain("sn");
  const sn = vn?.children?.find((c) => c.id === "sn");
  expect(sn?.children?.map((c) => c.id)).toContain("nic");
});

it("exposedNodeIds returns each exposed NSG and its associated targets", () => {
  const g: Graph = {
    version: 4,
    edges: [],
    nodes: [
      { id: "nsg", name: "nsg", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null, internet_exposed: true, associated_ids: ["sn"] },
      { id: "sn", name: "sn", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
      { id: "nsg2", name: "nsg2", type: "azurerm_network_security_group", provider: "azurerm", module_path: [], change: null, internet_exposed: false, associated_ids: ["sn2"] },
      { id: "sn2", name: "sn2", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null },
    ],
  };
  const ids = exposedNodeIds(g);
  expect(ids.has("nsg")).toBe(true);
  expect(ids.has("sn")).toBe(true); // associated target of an exposed NSG
  expect(ids.has("nsg2")).toBe(false);
  expect(ids.has("sn2")).toBe(false);
});

it("networkProjection marks every kept vnet/subnet a container, incl. empty ones", () => {
  const g: Graph = {
    version: 4,
    edges: [],
    nodes: [
      { id: "vn", name: "vn", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
      { id: "sn-full", name: "full", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null, parent_id: "vn" },
      { id: "nic", name: "nic", type: "azurerm_network_interface", provider: "azurerm", module_path: [], change: null, parent_id: "sn-full" },
      { id: "sn-empty", name: "empty", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null, parent_id: "vn" },
    ],
  };
  const { containerIds } = networkProjection(g);
  expect([...containerIds].sort()).toEqual(["sn-empty", "sn-full", "vn"]);
});

it("toElkGraph keeps a forced empty container as a sized frame, not a leaf", () => {
  const g: Graph = {
    version: 4,
    edges: [{ from: "vn", to: "sn", kind: "contains" }],
    nodes: [
      { id: "vn", name: "vn", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
      { id: "sn", name: "sn", type: "azurerm_subnet", provider: "azurerm", module_path: [], change: null, parent_id: "vn" },
    ],
  };
  const elk = toElkGraph(g, undefined, new Set(["vn", "sn"]));
  const vn = elk.children?.find((c) => c.id === "vn");
  const sn = vn?.children?.find((c) => c.id === "sn");
  // sn holds nothing but is still a container: empty children array + a min size.
  expect(sn?.children).toEqual([]);
  expect(sn?.layoutOptions?.["elk.nodeSize.minimum"]).toBeTruthy();
});

// --- Orthogonal routing + calm resting state --------------------------------

it("asks ELK to route edges orthogonally", () => {
  // React Flow throws ELK's route away and draws a bezier unless we render the
  // bend points ourselves — so the option and the renderer must stay in step.
  expect(ELK_ROOT_OPTIONS["elk.edgeRouting"]).toBe("ORTHOGONAL");
});

it("hands each flow edge the route ELK computed for it", () => {
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 300, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 0, y: 0, width: 220, height: 56 },
    ],
    edges: [
      {
        id: depEdgeId({ from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" }),
        sources: ["aws_s3.b"],
        targets: ["aws_s3.a"],
        sections: [
          {
            id: "s1",
            startPoint: { x: 220, y: 28 },
            endPoint: { x: 300, y: 28 },
            bendPoints: [{ x: 260, y: 28 }],
          },
        ],
      },
    ],
  };

  const { edges } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });

  // The *whole* polyline, endpoints included. Taking only the bend points and
  // pinning the ends to React Flow's handles assumes ELK always leaves a node on
  // its right and arrives on its left; give it containers to route around and it
  // will not, and the drawn line doubles back across the diagram to reach a bend
  // it was never going to start from.
  expect(edges[0]?.data?.route).toEqual([
    { x: 220, y: 28 },
    { x: 260, y: 28 },
    { x: 300, y: 28 },
  ]);
});

it("resolves a container-relative route into absolute coordinates", () => {
  // The trap ELK sets: edge coordinates come back relative to the *lowest common
  // ancestor* of the edge's endpoints, not relative to the node the edge was
  // declared under and not absolutely. Both these nodes live in the same
  // container, so ELK's numbers are relative to it; read as absolute, the edge is
  // drawn shifted up and to the left by the container's origin and ends up
  // hanging off the outside of the very box that owns it.
  const edgeId = depEdgeId({ from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" });
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      {
        // Both endpoints live in this group, so it is their lowest common
        // ancestor — and ELK's numbers below are relative to *it*, not the canvas.
        id: "group:g1",
        x: 100,
        y: 200,
        width: 600,
        height: 200,
        children: [
          { id: "aws_s3.b", x: 16, y: 36, width: 220, height: 56 },
          { id: "aws_s3.a", x: 336, y: 36, width: 220, height: 56 },
        ],
      },
    ],
    edges: [
      {
        id: edgeId,
        sources: ["aws_s3.b"],
        targets: ["aws_s3.a"],
        sections: [
          {
            id: "s1",
            startPoint: { x: 236, y: 64 }, // b's right edge, in group coordinates
            endPoint: { x: 336, y: 64 }, // a's left edge, in group coordinates
            bendPoints: [{ x: 286, y: 64 }],
          },
        ],
      },
    ],
  };

  const { edges } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });

  // Every point shifted by the group's origin (100, 200) — so the edge lands on
  // the two boxes it joins instead of floating above and left of their container.
  expect(edges[0]?.data?.route).toEqual([
    { x: 336, y: 264 },
    { x: 386, y: 264 },
    { x: 436, y: 264 },
  ]);
});

it("leaves a container-crossing route alone — ELK already gave it absolutely", () => {
  const edgeId = depEdgeId({ from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" });
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      {
        id: "group:g1",
        x: 100,
        y: 200,
        width: 260,
        height: 130,
        children: [{ id: "aws_s3.b", x: 16, y: 36, width: 220, height: 56 }],
      },
      { id: "aws_s3.a", x: 500, y: 236, width: 220, height: 56 },
    ],
    edges: [
      {
        id: edgeId,
        sources: ["aws_s3.b"],
        targets: ["aws_s3.a"],
        sections: [
          {
            id: "s1",
            // Their lowest common ancestor is the root, so these are absolute
            // already and must not be shifted a second time.
            startPoint: { x: 336, y: 264 },
            endPoint: { x: 500, y: 264 },
            bendPoints: [],
          },
        ],
      },
    ],
  };

  const { edges } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });

  expect(edges[0]?.data?.route).toEqual([
    { x: 336, y: 264 },
    { x: 500, y: 264 },
  ]);
});

it("keeps ELK's endpoints even when it routed the edge backwards", () => {
  // The case that breaks handle-pinning: ELK left the source on its *left* side
  // and came into the target from the *right*, going around a container. Drawing
  // that from the source's right handle would send the line back across the
  // whole diagram before it turned around.
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 600, y: 0, width: 220, height: 56 },
    ],
    edges: [
      {
        id: depEdgeId({ from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" }),
        sources: ["aws_s3.b"],
        targets: ["aws_s3.a"],
        sections: [
          {
            id: "s1",
            startPoint: { x: 600, y: 28 }, // b's LEFT edge
            endPoint: { x: 110, y: 56 }, // a's BOTTOM edge
            bendPoints: [
              { x: 560, y: 28 },
              { x: 560, y: 120 },
              { x: 110, y: 120 },
            ],
          },
        ],
      },
    ],
  };

  const { edges } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });

  const route = edges[0]?.data?.route as { x: number; y: number }[];
  expect(route[0]).toEqual({ x: 600, y: 28 });
  expect(route.at(-1)).toEqual({ x: 110, y: 56 });
});

it("matches routes to edges by their endpoints, not by position in the list", () => {
  // The layout drops hub edges and the render does not, so index-based ids drift
  // apart — and an edge would silently inherit a different edge's route.
  const a = depEdgeId({ from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" });
  const b = depEdgeId({ from: "aws_s3.b", to: "aws_s3.a", kind: "depends_on" });
  expect(a).not.toBe(b);
  expect(depEdgeId({ from: "aws_s3.a", to: "aws_s3.b", kind: "depends_on" })).toBe(a);
});

it("lights the hovered node's edges and pushes the rest back", () => {
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 300, y: 0, width: 220, height: 56 },
      {
        id: "module.net",
        x: 0,
        y: 120,
        width: 260,
        height: 120,
        children: [{ id: "module.net.aws_vpc.v", x: 16, y: 36, width: 220, height: 56 }],
      },
    ],
  };

  // At rest nothing is singled out: no node dimmed, no edge lit.
  const resting = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });
  expect(resting.edges[0]?.data?.active).toBe(false);
  expect(resting.edges[0]?.data?.dimmed).toBe(false);

  // Hovering focuses exactly as selecting does — the diagram answers the pointer.
  const hovered = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
    hoveredId: "aws_s3.a",
  });
  expect(hovered.edges[0]?.data?.active).toBe(true);
  // A resource unrelated to the hovered node recedes.
  expect(hovered.nodes.find((n) => n.id === "module.net.aws_vpc.v")?.data.dimmed).toBe(
    true,
  );

  // A selection is sticky: hovering elsewhere must not yank you out of it.
  const pinned = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: "aws_s3.a",
    hoveredId: "aws_s3.b",
  });
  expect(pinned.nodes.find((n) => n.id === "aws_s3.a")?.data.selected).toBe(true);
});

it("counts what each filter option covers", () => {
  expect(moduleCounts(graph).get("root")).toBe(2); // the two buckets
  expect(moduleCounts(graph).get("net")).toBe(1); // the vpc inside module.net

  // Module nodes are structure, not resources — they never appear in a count.
  const resources = graph.nodes.filter((n) => n.type !== "module").length;
  const total = [...categoryCounts(graph).values()].reduce((a, b) => a + b, 0);
  expect(total).toBe(resources);
});

it("hovering a hub reveals the connections it hides at rest (GP-35)", () => {
  const hubGraph: Graph = {
    version: 1,
    nodes: [
      { id: "rg", name: "rg", type: "azurerm_resource_group", provider: "azurerm", module_path: [], change: null },
      { id: "a", name: "a", type: "aws_s3", provider: "aws", module_path: [], change: null },
    ],
    edges: [{ from: "a", to: "rg", kind: "depends_on" }],
  };
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "rg", x: 0, y: 0, width: 220, height: 56 },
      { id: "a", x: 300, y: 0, width: 220, height: 56 },
    ],
  };
  const hubs = new Set(["rg"]);

  const resting = elkToFlow(layout, hubGraph, {
    activeFilters: allFilters,
    selectedId: null,
    hubs,
  });
  expect(resting.edges).toHaveLength(0); // the hub's edge wall stays down

  const hovered = elkToFlow(layout, hubGraph, {
    activeFilters: allFilters,
    selectedId: null,
    hoveredId: "rg",
    hubs,
  });
  // Pointing at the hub is how you ask what it connects to. Lighting its
  // neighbours while drawing no line to them would be a worse lie than hiding both.
  expect(hovered.edges).toHaveLength(1);
});

it("declares every node's size, so React Flow never re-measures the diagram", () => {
  // React Flow hides a node it considers unmeasured (`nodeHasDimensions`:
  // measured ?? width ?? initialWidth). It reads `measured` only from the node
  // object we hand it — so a node rebuilt without one blanks until a
  // ResizeObserver catches up. We rebuild every node on hover, so that blank was
  // the whole diagram, on every pointer move. ELK already told us the size.
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      {
        id: "module.net",
        x: 0,
        y: 120,
        width: 260,
        height: 120,
        children: [{ id: "module.net.aws_vpc.v", x: 16, y: 36, width: 220, height: 56 }],
      },
    ],
  };

  const { nodes } = elkToFlow(layout, graph, {
    activeFilters: allFilters,
    selectedId: null,
  });

  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) {
    expect(node.width, `${node.id} declares a width`).toBeGreaterThan(0);
    expect(node.height, `${node.id} declares a height`).toBeGreaterThan(0);
    expect(node.measured).toEqual({ width: node.width, height: node.height });
  }
});

// --- The adapted projection renders like any other graph (GP-74) -------------

describe("adapted graphs", () => {
  const adapted: Graph = {
    version: 5,
    nodes: [
      {
        id: "group:g1",
        name: "Storefront",
        type: "group",
        provider: null,
        module_path: [],
        change: null,
        annotation_group: true,
      },
      {
        id: "aws_s3_bucket.data",
        name: "data",
        type: "aws_s3_bucket",
        provider: "aws",
        module_path: [],
        change: null,
      },
      {
        id: "aws_lambda_function.api",
        name: "api",
        type: "aws_lambda_function",
        provider: "aws",
        module_path: [],
        change: null,
      },
    ],
    edges: [
      { from: "group:g1", to: "aws_s3_bucket.data", kind: "contains" },
      {
        from: "aws_lambda_function.api",
        to: "aws_s3_bucket.data",
        kind: "logical",
        label: "publishes to",
      },
    ],
  };

  it("renders an annotation group as its own node type, not a module box", () => {
    const layout = toElkGraph(adapted);
    const { nodes } = elkToFlow(layout, adapted);
    const group = nodes.find((n) => n.id === "group:g1");
    // A module container and a human's group are different claims about the
    // system; they must not look like the same thing.
    expect(group?.type).toBe("groupContainer");
    expect(nodes.find((n) => n.id === "aws_s3_bucket.data")?.parentId).toBe("group:g1");
  });

  it("draws logical edges with the annotation treatment and their label", () => {
    const layout = toElkGraph(adapted);
    const { edges } = elkToFlow(layout, adapted);
    const logical = edges.find((e) => e.id.startsWith("log|"));
    expect(logical?.data?.annotation).toBe(true);
    expect(logical?.data?.label).toBe("publishes to");
  });

  it("lays logical edges out through ELK, rather than routing them afterwards", () => {
    // A relationship a human drew is a real relationship: ELK should place its
    // endpoints, not have the line thrown over the finished picture.
    const elk = toElkGraph(adapted);
    expect(elk.edges?.some((e) => e.id.startsWith("log|"))).toBe(true);
  });

  it("still draws no line for a `contains` edge — that is nesting, not a relationship", () => {
    const layout = toElkGraph(adapted);
    const { edges } = elkToFlow(layout, adapted);
    expect(edges.some((e) => e.source === "group:g1" || e.target === "group:g1")).toBe(
      false,
    );
  });
});

describe("the tour spotlight (GP-79)", () => {
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "aws_s3.a", x: 0, y: 0, width: 220, height: 56 },
      { id: "aws_s3.b", x: 300, y: 0, width: 220, height: 56 },
      {
        id: "module.net",
        x: 0,
        y: 120,
        width: 260,
        height: 120,
        children: [
          { id: "module.net.aws_vpc.v", x: 16, y: 36, width: 220, height: 56 },
        ],
      },
    ],
  };

  const view = (tourAnchors: ReadonlySet<string> | null) =>
    elkToFlow(layout, graph, {
      activeFilters: allFilters,
      selectedId: null,
      tourAnchors,
    });

  it("lights the stop and pushes everything else back", () => {
    const { nodes } = view(new Set(["aws_s3.a"]));

    const lit = nodes.find((n) => n.id === "aws_s3.a");
    expect(lit?.data.dimmed).toBe(false);
    expect(nodes.find((n) => n.id === "aws_s3.b")?.data.dimmed).toBe(true);
    // Even a container dims: when the stop is one resource, leaving every module
    // frame bright is a spotlight with the house lights still on.
    expect(nodes.find((n) => n.id === "module.net")?.data.dimmed).toBe(true);
  });

  it("frames a whole module when the stop is the module", () => {
    const { nodes } = view(new Set(["module.net"]));
    expect(nodes.find((n) => n.id === "module.net")?.data.dimmed).toBe(false);
    expect(nodes.find((n) => n.id === "aws_s3.a")?.data.dimmed).toBe(true);
  });

  it("dims nothing on the whole-diagram stop", () => {
    // The opener and the closer are about the change as a whole. There is nothing
    // to single out, so nothing recedes.
    const { nodes } = view(new Set());
    expect(nodes.every((n) => n.data.dimmed === false)).toBe(true);
  });

  it("lights an edge only when the stop is about both its ends", () => {
    const both = view(new Set(["aws_s3.a", "aws_s3.b"]));
    const edge = both.edges.find((e) => e.id === depEdgeId(graph.edges[1]!));
    expect(edge?.data?.active).toBe(true);
    expect(edge?.data?.dimmed).toBe(false);

    // One end lit and one in the dark is not the point being made.
    const one = view(new Set(["aws_s3.a"]));
    const half = one.edges.find((e) => e.id === depEdgeId(graph.edges[1]!));
    expect(half?.data?.active).toBe(false);
    expect(half?.data?.dimmed).toBe(true);
  });

  it("outranks a selection — a narration must not flicker with the cursor", () => {
    const { nodes } = elkToFlow(layout, graph, {
      activeFilters: allFilters,
      selectedId: "aws_s3.b",
      hoveredId: "aws_s3.b",
      tourAnchors: new Set(["aws_s3.a"]),
    });

    expect(nodes.find((n) => n.id === "aws_s3.a")?.data.dimmed).toBe(false);
    expect(nodes.find((n) => n.id === "aws_s3.b")?.data.dimmed).toBe(true);
  });
});

/**
 * The filters are seeded from the option lists — `new Set(moduleOptions(graph))`,
 * `new Set(categoryOptions(graph))` — so an option list that omits a node's key
 * does not hide a checkbox: it dims the node, permanently, with no way to get it
 * back. A graph with no modules at all (every Kubernetes graph, and any Terraform
 * repository that never wrote one) is exactly that case.
 */
describe("the filter options the canvas seeds itself from", () => {
  const moduleless: Graph = {
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

  it("cover every node of a graph with no modules, so none of it is dimmed", () => {
    const layout = { id: "root", children: moduleless.nodes.map((n) => ({ id: n.id, x: 0, y: 0, width: 10, height: 10 })) } as ElkGraphNode;

    const { nodes } = elkToFlow(layout, moduleless, {
      activeFilters: allFilters,
      activeCategories: new Set(categoryOptions(moduleless)),
      activeModules: new Set(moduleOptions(moduleless)),
      selectedId: null,
    });

    expect(nodes.filter((n) => n.data.dimmed)).toEqual([]);
  });
});

// --- GP-87: resource stacking (satellites nest inside their host card) -------

/** vnet ⊃ subnet ⊃ lb (host), with three lb satellites stacked under the lb and
 *  one external neighbour the probe depends on. */
function stackFixture(): Graph {
  const n = (id: string, type: string, over: Partial<Graph["nodes"][number]> = {}) => ({
    id, name: id, type, provider: "azurerm" as const, module_path: [] as string[], change: null, ...over,
  });
  return {
    version: 4,
    nodes: [
      n("vnet", "azurerm_virtual_network"),
      n("subnet", "azurerm_subnet", { parent_id: "vnet" }),
      n("lb", "azurerm_lb", { parent_id: "subnet" }),
      n("probe", "azurerm_lb_probe", { parent_id: "lb", change: "update" }),
      n("pool", "azurerm_lb_backend_address_pool", { parent_id: "lb" }),
      n("rule", "azurerm_lb_rule", { parent_id: "lb" }),
      n("web", "azurerm_linux_virtual_machine", { parent_id: "subnet" }),
    ],
    edges: [{ from: "probe", to: "web", kind: "depends_on" }],
  };
}

const CONTAINERS = new Set(["vnet", "subnet"]);

function collectElkIds(node: ElkGraphNode, out: string[] = []): string[] {
  out.push(node.id);
  for (const c of node.children ?? []) collectElkIds(c, out);
  return out;
}

function findElk(node: ElkGraphNode, id: string): ElkGraphNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findElk(c, id);
    if (hit) return hit;
  }
  return undefined;
}

it("resourceStacks groups satellite children under their host, sorted", () => {
  const stacks = resourceStacks(stackFixture(), CONTAINERS);
  expect([...stacks.keys()]).toEqual(["lb"]);
  expect(stacks.get("lb")?.map((c) => c.id)).toEqual(["pool", "probe", "rule"]);
});

it("networkProjection stacks satellites but keeps container nesting", () => {
  const { graph: projected, stacks } = networkProjection(stackFixture());
  // Children stay in the graph (search + detail panel still resolve them)…
  expect(projected.nodes.map((n) => n.id)).toContain("probe");
  // …but there is no contains edge from the resource host to its children.
  expect(projected.edges.some((e) => e.kind === "contains" && e.from === "lb")).toBe(false);
  // The container chain still nests via contains.
  expect(projected.edges).toContainEqual({ from: "subnet", to: "lb", kind: "contains" });
  expect(stacks.get("lb")?.map((c) => c.id)).toEqual(["pool", "probe", "rule"]);
});

it("toElkGraph omits stacked children and sizes the host taller", () => {
  const { graph: projected, stacks } = networkProjection(stackFixture());
  const elk = toElkGraph(projected, undefined, CONTAINERS, stacks);
  const ids = collectElkIds(elk);
  expect(ids).not.toContain("probe");
  expect(ids).not.toContain("pool");
  expect(ids).toContain("lb");
  const lb = findElk(elk, "lb");
  expect(lb?.height ?? 0).toBeGreaterThan(56); // header + three rows
});

it("elkToFlow delivers the stack to the host node data and flags a changed child", () => {
  const { graph: projected, stacks } = networkProjection(stackFixture());
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "lb", x: 0, y: 0, width: 220, height: 120 },
      { id: "web", x: 300, y: 0, width: 220, height: 56 },
    ],
  };
  const { nodes, edges } = elkToFlow(layout, projected, {
    activeFilters: allFilters,
    selectedId: null,
    stacks,
  });
  const lb = nodes.find((n) => n.id === "lb");
  expect(lb?.data.stack?.map((c) => c.id)).toEqual(["pool", "probe", "rule"]);
  expect(lb?.data.stackChanged).toBe(true); // probe change=update
  // A stacked child has no flow node, so its edge is not drawn (GP-88 re-anchors).
  expect(nodes.some((n) => n.id === "probe")).toBe(false);
  expect(edges.some((e) => e.source === "probe" || e.target === "probe")).toBe(false);
});

// --- GP-88: edges around stacks (re-anchor to host, merge parallels) ---------

it("reanchorStackEdges re-anchors child endpoints to the host and merges parallels", () => {
  const childToHost = new Map([
    ["probe", "lb"],
    ["pool", "lb"],
    ["rule", "lb"],
  ]);
  const edges: GraphEdge[] = [
    { from: "probe", to: "web", kind: "depends_on", inferred: true },
    { from: "pool", to: "web", kind: "depends_on", inferred: true },
    { from: "rule", to: "probe", kind: "depends_on", inferred: true }, // both children of lb
    { from: "web", to: "lb", kind: "depends_on", inferred: true },
  ];
  const { edges: out, members } = reanchorStackEdges(edges, childToHost);
  // probe→web and pool→web collapse into one lb→web edge carrying ×2.
  const lbWeb = out.find((e) => e.from === "lb" && e.to === "web");
  expect(lbWeb?.count).toBe(2);
  // rule→probe: both endpoints re-anchor to lb → a self-loop, dropped.
  expect(out.some((e) => e.from === "lb" && e.to === "lb")).toBe(false);
  // The plain web→lb edge survives.
  expect(out.some((e) => e.from === "web" && e.to === "lb")).toBe(true);
  // The merged edge remembers the original endpoints behind it, so a stacked
  // child can still be lit even though the drawn edge names only the host.
  const members1 = members.get(depEdgeId(lbWeb!));
  expect([...(members1 ?? [])].sort()).toEqual(["pool", "probe", "web"]);
});

it("reanchorStackEdges leaves an edge without stacked endpoints untouched", () => {
  const { edges: out } = reanchorStackEdges(
    [{ from: "a", to: "b", kind: "depends_on", inferred: false }],
    new Map(),
  );
  expect(out).toEqual([{ from: "a", to: "b", kind: "depends_on", inferred: false }]);
});

it("elkToFlow draws re-anchored, merged edges and never terminates at a satellite", () => {
  const { graph: projected, stacks } = networkProjection({
    version: 4,
    nodes: stackFixture().nodes,
    edges: [
      { from: "probe", to: "web", kind: "depends_on", inferred: true },
      { from: "pool", to: "web", kind: "depends_on", inferred: true },
    ],
  });
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "lb", x: 0, y: 0, width: 220, height: 120 },
      { id: "web", x: 400, y: 0, width: 220, height: 56 },
    ],
  };
  const { edges } = elkToFlow(layout, projected, {
    activeFilters: allFilters,
    selectedId: null,
    stacks,
  });
  // One merged edge lb→web, none touching a satellite.
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ source: "web", target: "lb" }); // drawn dep→dependent
  expect(edges.some((e) => e.source === "probe" || e.target === "probe")).toBe(false);
  expect(edges[0]?.data?.label).toBe("×2");
});

it("selecting a stacked child lights exactly the merged edges it participates in", () => {
  const { graph: projected, stacks } = networkProjection({
    version: 4,
    nodes: stackFixture().nodes,
    edges: [
      { from: "probe", to: "web", kind: "depends_on", inferred: true },
      { from: "pool", to: "web", kind: "depends_on", inferred: true },
    ],
  });
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      { id: "lb", x: 0, y: 0, width: 220, height: 120 },
      { id: "web", x: 400, y: 0, width: 220, height: 56 },
    ],
  };
  const { edges } = elkToFlow(layout, projected, {
    activeFilters: allFilters,
    selectedId: "probe", // a stacked child
    stacks,
  });
  // The merged lb→web edge carries the probe, so selecting the probe lights it.
  expect(edges[0]?.data?.active).toBe(true);
  expect(edges[0]?.data?.dimmed).toBe(false);
});

it("hub detection counts merged edges, dropping a node that only fanned out via a stack", () => {
  // 16 satellites of `lb`, all depending on `web` → `web` has degree 16 raw
  // (> HUB_DEGREE_THRESHOLD of 15), but one merged lb→web edge after re-anchoring.
  const children = Array.from({ length: 16 }, (_, i) => `probe${i}`);
  const nodes = [
    { id: "web", name: "web", type: "azurerm_linux_virtual_machine", provider: "azurerm", module_path: [], change: null },
    ...children.map((id) => ({ id, name: id, type: "azurerm_lb_probe", provider: "azurerm" as const, module_path: [] as string[], change: null })),
  ];
  const edges: GraphEdge[] = children.map((id) => ({ from: id, to: "web", kind: "depends_on" as const, inferred: true }));
  const rawGraph: Graph = { version: 4, nodes, edges };
  const childToHost = new Map(children.map((id) => [id, "lb"]));
  const merged = reanchorStackEdges(edges, childToHost).edges;
  const mergedGraph: Graph = { version: 4, nodes, edges: merged };

  expect(detectHubs(rawGraph).has("web")).toBe(true); // 16 raw edges → a hub
  expect(detectHubs(mergedGraph).has("web")).toBe(false); // one merged edge → not
});

// --- GP-89: subnet chips (NSG / route table attach to their subnet) ----------

/** vnet ⊃ subnet, guarded by an NSG (associated) and a route table; a second
 *  NSG guards the NIC card inside the subnet (a top-level card → a chip home). */
function chipFixture(): Graph {
  const n = (id: string, type: string, over: Partial<Graph["nodes"][number]> = {}) => ({
    id, name: id, type, provider: "azurerm" as const, module_path: [] as string[], change: null, ...over,
  });
  return {
    version: 4,
    nodes: [
      n("vnet", "azurerm_virtual_network"),
      n("subnet", "azurerm_subnet", { parent_id: "vnet" }),
      n("nic", "azurerm_network_interface", { parent_id: "subnet" }),
      n("nsg", "azurerm_network_security_group", { associated_ids: ["subnet"], change: "update" }),
      n("rt", "azurerm_route_table", { associated_ids: ["subnet"] }),
      // Guards the NIC — which renders as its own card, so the chip rides on it.
      n("nicGuard", "azurerm_network_security_group", { associated_ids: ["nic"] }),
    ],
    edges: [{ from: "nsg", to: "nic", kind: "depends_on", inferred: true }],
  };
}

it("attachmentChips groups NSGs / route tables under the subnet they guard", () => {
  const { chips } = networkProjection(chipFixture());
  expect(chips.get("subnet")?.map((c) => c.id)).toEqual(["nsg", "rt"]);
});

it("networkProjection removes chip nodes from the layout, wherever they anchor", () => {
  const { graph: projected, chips } = networkProjection(chipFixture());
  // Chip nodes stay in the graph (search + detail resolve them)…
  expect(projected.nodes.map((n) => n.id)).toEqual(
    expect.arrayContaining(["nsg", "rt", "nicGuard"]),
  );
  // …the NIC-guarding NSG chips onto the NIC's card (a top-level card).
  expect(chips.get("nic")?.map((c) => c.id)).toEqual(["nicGuard"]);
  const elk = toElkGraph(projected, undefined, new Set(["vnet", "subnet"]), undefined, chips);
  const ids = collectElkIds(elk);
  expect(ids).not.toContain("nsg"); // laid out as a chip, not a floating node
  expect(ids).not.toContain("rt");
  expect(ids).not.toContain("nicGuard"); // rides on the NIC card
});

it("elkToFlow delivers chips to the subnet container node data", () => {
  const { graph: projected, chips, containerIds } = networkProjection(chipFixture());
  const layout: ElkGraphNode = {
    id: "root",
    children: [
      {
        id: "vnet", x: 0, y: 0, width: 400, height: 300,
        children: [{ id: "subnet", x: 20, y: 40, width: 320, height: 200, children: [{ id: "nic", x: 20, y: 60, width: 220, height: 56 }] }],
      },
      { id: "orphan", x: 500, y: 0, width: 220, height: 56 },
    ],
  };
  const { nodes } = elkToFlow(layout, projected, {
    activeFilters: allFilters,
    selectedId: null,
    containerIds,
    chips,
  });
  const subnet = nodes.find((n) => n.id === "subnet");
  expect(subnet?.data.chips?.map((c) => c.id)).toEqual(["nsg", "rt"]);
});

it("networkProjection drops edge-join plumbing (peerings, links) but keeps the direct edge", () => {
  const g: Graph = {
    version: 4,
    nodes: [
      { id: "hub", name: "hub", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
      { id: "spoke", name: "spoke", type: "azurerm_virtual_network", provider: "azurerm", module_path: [], change: null },
      { id: "peer", name: "peer", type: "azurerm_virtual_network_peering", provider: "azurerm", module_path: [], change: null },
    ],
    edges: [
      // The peering's own reference edges, plus the direct edge the backend
      // join catalog now emits between the two vnets.
      { from: "peer", to: "hub", kind: "depends_on", inferred: true },
      { from: "peer", to: "spoke", kind: "depends_on", inferred: true },
      { from: "hub", to: "spoke", kind: "depends_on", inferred: true },
    ],
  };
  const { graph: projected, hiddenCount } = networkProjection(g);
  const ids = projected.nodes.map((n) => n.id).sort();
  expect(ids).toEqual(["hub", "spoke"]); // the peering box is plumbing
  expect(hiddenCount).toBe(0); // plumbing isn't a "hidden resource"
  expect(projected.edges).toContainEqual({ from: "hub", to: "spoke", kind: "depends_on", inferred: true });
});

// --- host-card chips (avset on its member VMs, network-schema-polish) --------

/** vnet ⊃ subnet ⊃ two VMs sharing an availability set; one VM stacks a NIC
 *  guarded by an NSG (stacked anchor → no chip home). */
function cardChipFixture(): Graph {
  const n = (id: string, type: string, over: Partial<Graph["nodes"][number]> = {}) => ({
    id, name: id, type, provider: "azurerm" as const, module_path: [] as string[], change: null, ...over,
  });
  return {
    version: 4,
    nodes: [
      n("vnet", "azurerm_virtual_network"),
      n("subnet", "azurerm_subnet", { parent_id: "vnet" }),
      n("vm1", "azurerm_linux_virtual_machine", { parent_id: "subnet" }),
      n("vm2", "azurerm_linux_virtual_machine", { parent_id: "subnet" }),
      n("avset", "azurerm_availability_set", { associated_ids: ["vm1", "vm2"] }),
      n("nic", "azurerm_network_interface", { parent_id: "vm1" }),
      n("nicGuard", "azurerm_network_security_group", { associated_ids: ["nic"] }),
    ],
    edges: [],
  };
}

it("chips an avset onto its member VM cards and hides its node from the layout", () => {
  const { graph: projected, chips, stacks, containerIds } = networkProjection(cardChipFixture());
  expect(chips.get("vm1")?.map((c) => c.id)).toEqual(["avset"]);
  expect(chips.get("vm2")?.map((c) => c.id)).toEqual(["avset"]);
  const elk = toElkGraph(projected, undefined, containerIds, stacks, chips);
  expect(collectElkIds(elk)).not.toContain("avset");
});

it("keeps a satellite floating when its only anchor is itself stacked", () => {
  // The NSG guards a NIC stacked inside vm1: no chip home → stays a node.
  const { graph: projected, chips, stacks, containerIds } = networkProjection(cardChipFixture());
  expect([...chips.values()].flat().some((c) => c.id === "nicGuard")).toBe(false);
  const elk = toElkGraph(projected, undefined, containerIds, stacks, chips);
  expect(collectElkIds(elk)).toContain("nicGuard");
});

it("a chip-carrying resource card reserves extra height", () => {
  const { graph: projected, chips, stacks, containerIds } = networkProjection(cardChipFixture());
  const elk = toElkGraph(projected, undefined, containerIds, stacks, chips);
  const vm2 = findElk(elk, "vm2"); // no stack, one chip
  expect(vm2?.height).toBeGreaterThan(56);
});

// --- subnet ordering by CIDR (network-schema-polish) -------------------------

it("orders a vnet's subnets by CIDR, not by id", () => {
  const n = (id: string, type: string, over: Partial<Graph["nodes"][number]> = {}) => ({
    id, name: id, type, provider: "azurerm" as const, module_path: [] as string[], change: null, ...over,
  });
  // Ids chosen so alphabetical order (sa, sb, sc) differs from CIDR order.
  const graph: Graph = {
    version: 7,
    nodes: [
      n("vnet", "azurerm_virtual_network"),
      n("sa", "azurerm_subnet", { parent_id: "vnet", attributes: { address_prefixes: "10.0.3.0/24" } }),
      n("sb", "azurerm_subnet", { parent_id: "vnet", attributes: { address_prefixes: "10.0.1.0/24" } }),
      n("sc", "azurerm_subnet", { parent_id: "vnet", attributes: { address_prefixes: "10.0.2.0/24" } }),
      n("sd", "azurerm_subnet", { parent_id: "vnet" }), // no CIDR → sorts last
    ],
    edges: ["sa", "sb", "sc", "sd"].map((id) => ({ from: "vnet", to: id, kind: "contains" as const })),
  };
  const elk = toElkGraph(graph);
  const vnet = findElk(elk, "vnet");
  expect(vnet?.children?.map((c) => c.id)).toEqual(["sb", "sc", "sa", "sd"]);
  // No model-order options: they crash elkjs inside an INCLUDE_CHILDREN
  // hierarchy (see graph-layout.elk.test.ts) — the sort alone must stay.
  expect(
    vnet?.layoutOptions?.["elk.layered.considerModelOrder.strategy"],
  ).toBeUndefined();
  expect(
    vnet?.layoutOptions?.["elk.layered.crossingMinimization.forceNodeModelOrder"],
  ).toBeUndefined();
});

describe("diff emphasis (GP-155)", () => {
  // changed <- hit(impacted) <- near(context) <- far(ghost)
  const diffGraph: Graph = {
    version: 3,
    nodes: [
      { id: "changed", name: "changed", type: "t", provider: "p", module_path: [], change: "update" },
      { id: "hit", name: "hit", type: "t", provider: "p", module_path: [], change: "noop", impacted: true, impact_distance: 1 },
      { id: "near", name: "near", type: "t", provider: "p", module_path: [], change: "noop" },
      { id: "far", name: "far", type: "t", provider: "p", module_path: [], change: "noop" },
    ],
    edges: [
      { from: "hit", to: "changed", kind: "depends_on" },
      { from: "near", to: "hit", kind: "depends_on" },
      { from: "far", to: "near", kind: "depends_on" },
    ],
  };
  const diffLayout: ElkGraphNode = {
    id: "root",
    children: diffGraph.nodes.map((n, i) => ({
      id: n.id,
      x: i * 300,
      y: 0,
      width: 220,
      height: 56,
    })),
  };

  it("hands each node its emphasis tier when diffEmphasis is on", () => {
    const { nodes, edges } = elkToFlow(diffLayout, diffGraph, {
      activeFilters: allFilters,
      selectedId: null,
      diffEmphasis: true,
    });
    const emphasisOf = (id: string) =>
      nodes.find((n) => n.id === id)?.data.emphasis;
    expect(emphasisOf("changed")).toBe("changed");
    expect(emphasisOf("hit")).toBe("impacted");
    expect(emphasisOf("near")).toBe("context");
    expect(emphasisOf("far")).toBe("ghost");

    // Edges: full contrast only while an endpoint carries the signal.
    const ghostedOf = (id: string) =>
      edges.find((e) => e.id === id)?.data?.ghosted;
    expect(ghostedOf(depEdgeId({ from: "hit", to: "changed", kind: "depends_on" }))).toBeUndefined();
    expect(ghostedOf(depEdgeId({ from: "far", to: "near", kind: "depends_on" }))).toBe(true);
  });

  it("carries no emphasis when off — HEAD/MAIN render exactly as before", () => {
    const { nodes } = elkToFlow(diffLayout, diffGraph, {
      activeFilters: allFilters,
      selectedId: null,
    });
    expect(nodes.every((n) => n.data.emphasis === undefined)).toBe(true);
  });

  it("selection overrides ghosting: the lit neighbourhood renders full", () => {
    const { nodes } = elkToFlow(diffLayout, diffGraph, {
      activeFilters: allFilters,
      selectedId: "far", // a ghosted node the user clicked
      diffEmphasis: true,
    });
    const far = nodes.find((n) => n.id === "far");
    const near = nodes.find((n) => n.id === "near"); // its neighbour
    expect(far?.data.emphasis).toBeUndefined();
    expect(far?.data.dimmed).toBe(false);
    expect(near?.data.emphasis).toBeUndefined();
  });
});
