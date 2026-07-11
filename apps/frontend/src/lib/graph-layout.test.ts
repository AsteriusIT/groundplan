import { expect, it } from "vitest";

import type { Graph } from "@/api/types";
import {
  ALL_FILTERS,
  changeClasses,
  elkToFlow,
  neighborhood,
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
  // Only the depends_on edge becomes an ELK edge (contains → nesting).
  expect(elk.edges).toHaveLength(1);
  expect(elk.edges?.[0]).toMatchObject({
    sources: ["aws_s3.a"],
    targets: ["aws_s3.b"],
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

  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ source: "aws_s3.a", target: "aws_s3.b" });
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
