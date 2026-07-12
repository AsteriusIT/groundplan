import { expect, it } from "vitest";

import type { Graph } from "@/api/types";
import {
  ALL_FILTERS,
  changeClasses,
  elkToFlow,
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
