import { describe, expect, it } from "vitest";

import type { Graph, SnapshotDiff } from "@/api/types";
import { buildCompareGraph, diffIsEmpty } from "./snapshot-diff";

const target: Graph = {
  version: 1,
  nodes: [
    { id: "module.net", name: "net", type: "module", provider: null, module_path: [], change: null },
    { id: "azurerm_subnet.a", name: "a", type: "azurerm_subnet", provider: "azurerm", module_path: ["net"], change: null },
    { id: "azurerm_subnet.b", name: "b", type: "azurerm_subnet", provider: "azurerm", module_path: ["net"], change: null },
  ],
  edges: [{ from: "module.net", to: "azurerm_subnet.a", kind: "contains" }],
};

const diff: SnapshotDiff = {
  base: { id: "s0", commitSha: "0000", createdAt: "2026-07-01T00:00:00Z" },
  target: { id: "s1", commitSha: "1111", createdAt: "2026-07-11T00:00:00Z" },
  added: [{ id: "azurerm_subnet.b", name: "b", type: "azurerm_subnet", module_path: ["net"] }],
  removed: [{ id: "azurerm_subnet.old", name: "old", type: "azurerm_subnet", module_path: [] }],
  moved: [],
  unchangedCount: 1,
};

describe("buildCompareGraph", () => {
  const compare = buildCompareGraph(target, diff);
  const byId = Object.fromEntries(compare.nodes.map((n) => [n.id, n]));

  it("colours added nodes as create and unchanged as noop", () => {
    expect(byId["azurerm_subnet.b"]!.change).toBe("create");
    expect(byId["azurerm_subnet.a"]!.change).toBe("noop");
  });

  it("keeps modules structural (no change)", () => {
    expect(byId["module.net"]!.change).toBeNull();
  });

  it("injects removed nodes as delete ghosts", () => {
    expect(byId["azurerm_subnet.old"]!.change).toBe("delete");
  });

  it("drops edges whose endpoints are absent (ghosts have none)", () => {
    for (const e of compare.edges) {
      expect(byId[e.from]).toBeDefined();
      expect(byId[e.to]).toBeDefined();
    }
  });
});

describe("diffIsEmpty", () => {
  it("is true only when nothing changed", () => {
    expect(diffIsEmpty({ ...diff, added: [], removed: [], moved: [] })).toBe(true);
    expect(diffIsEmpty(diff)).toBe(false);
  });
});
