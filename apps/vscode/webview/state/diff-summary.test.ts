/**
 * The counters the Diff button prints. They are `computeGraphStats` over the
 * differ's own output — the fold the backend stores beside every snapshot and
 * the PR comment counts with — so the panel and the PR cannot disagree about
 * how many things changed.
 */
import { describe, expect, test } from "vitest";
import type { ChangeKind, Graph, GraphNode } from "@groundplan/graph-parser";

import { diffCounts } from "./diff-summary";

/** A resource node with just enough shape to be counted. */
function node(
  id: string,
  change: ChangeKind | null,
  impacted = false,
): GraphNode {
  return {
    id,
    name: id,
    type: "azurerm_storage_account",
    provider: "azurerm",
    module_path: [],
    change,
    ...(impacted ? { impacted: true } : {}),
  };
}

function graph(nodes: GraphNode[]): Graph {
  return { version: 2, nodes, edges: [] };
}

describe("diffCounts", () => {
  test("an all-noop diff counts nothing and reads clean", () => {
    const counts = diffCounts(graph([node("a", "noop"), node("b", "noop")]));

    expect(counts).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      impacted: 0,
      total: 0,
    });
  });

  test("counts creates on their own", () => {
    const counts = diffCounts(
      graph([node("a", "create"), node("b", "create"), node("c", "noop")]),
    );

    expect(counts.created).toBe(2);
    expect(counts.updated).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.total).toBe(2);
  });

  test("counts a mixed change set", () => {
    const counts = diffCounts(
      graph([
        node("a", "create"),
        node("b", "update"),
        node("c", "update"),
        node("d", "delete"),
        node("e", "noop"),
      ]),
    );

    expect(counts).toEqual({
      created: 1,
      updated: 2,
      deleted: 1,
      impacted: 0,
      total: 4,
    });
  });

  test("impacted nodes are counted apart from the change set", () => {
    const counts = diffCounts(
      graph([
        node("a", "update"),
        node("b", "noop", true),
        node("c", "noop", true),
      ]),
    );

    expect(counts.impacted).toBe(2);
    // An impacted node is unchanged: it must never inflate the change total,
    // which is the number the Diff button prints.
    expect(counts.total).toBe(1);
  });

  test("nodes with no change at all (modules) count as nothing", () => {
    const counts = diffCounts(graph([node("module.net", null)]));

    expect(counts.total).toBe(0);
    expect(counts.impacted).toBe(0);
  });
});
