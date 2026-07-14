import { describe, expect, it } from "vitest";

import type { Graph } from "@/api/types";
import {
  ALL_FILTERS,
  categoryCounts,
  changeClasses,
  depEdgeId,
  ELK_ROOT_OPTIONS,
  elkToFlow,
  moduleCounts,
  exposedNodeIds,
  neighborhood,
  networkProjection,
  nodePassesFilters,
  toElkGraph,
  type ElkGraphNode,
} from "./graph-layout";

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
