/**
 * What a legend should say. The rule that matters is `presentOnly`: a legend
 * that lists a state the diagram does not contain is teaching the reader to
 * look for something that is not there, and eight permanent entries explaining
 * five that are on screen is how a legend stops being read.
 */
import { describe, expect, it } from "vitest";
import type { Graph, GraphEdge, GraphNode } from "../types";

import { buildLegendModel } from "./legend";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    name: id,
    type: "azurerm_storage_account",
    provider: "azurerm",
    module_path: [],
    change: null,
    ...over,
  };
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): Graph {
  return { version: 2, nodes, edges };
}

const dependsOn: GraphEdge = { from: "a", to: "b", kind: "depends_on" };
const inferred: GraphEdge = { from: "a", to: "b", kind: "depends_on", inferred: true };

describe("presentOnly", () => {
  it("lists only the change states the diagram actually contains", () => {
    const model = buildLegendModel(
      graph([
        node("a", { change: "create" }),
        node("b", { change: "create" }),
        node("c", { change: "noop" }),
      ]),
      { variant: "plan", presentOnly: true },
    );

    expect(model.changes.map((c) => c.key)).toEqual(["create", "noop"]);
  });

  it("counts each state, so the legend doubles as a tally", () => {
    const model = buildLegendModel(
      graph([node("a", { change: "create" }), node("b", { change: "create" })]),
      { variant: "plan", presentOnly: true },
    );

    expect(model.changes[0]).toMatchObject({ key: "create", count: 2 });
  });

  it("counts impacted nodes as their own state", () => {
    const model = buildLegendModel(
      graph([
        node("a", { change: "update" }),
        node("b", { change: "noop", impacted: true }),
      ]),
      { variant: "plan", presentOnly: true },
    );

    expect(model.changes.find((c) => c.key === "impacted")).toMatchObject({
      count: 1,
    });
  });

  it("says nothing about change on a diagram that has none", () => {
    const model = buildLegendModel(graph([node("a")]), {
      variant: "docs",
      presentOnly: true,
    });

    expect(model.changes).toEqual([]);
  });

  it("explains a dashed line only when one is drawn", () => {
    const withInferred = buildLegendModel(graph([node("a")], [inferred]), {
      variant: "docs",
      presentOnly: true,
    });
    const without = buildLegendModel(graph([node("a")], [dependsOn]), {
      variant: "docs",
      presentOnly: true,
    });

    expect(withInferred.edges.map((e) => e.key)).toContain("inferred");
    expect(without.edges.map((e) => e.key)).not.toContain("inferred");
  });

  it("explains a solid line only when one is drawn", () => {
    const model = buildLegendModel(graph([node("a")], [inferred]), {
      variant: "docs",
      presentOnly: true,
    });

    expect(model.edges.map((e) => e.key)).not.toContain("depends_on");
  });

  it("explains the muted data-source card only when one is on screen", () => {
    const withData = buildLegendModel(
      graph([node("data.azurerm_client_config.current")]),
      { variant: "docs", presentOnly: true },
    );
    const without = buildLegendModel(graph([node("a")]), {
      variant: "docs",
      presentOnly: true,
    });

    expect(withData.notes.map((n) => n.key)).toContain("data-source");
    expect(without.notes).toEqual([]);
  });

  it("is empty for an empty diagram, rather than a list of absent things", () => {
    const model = buildLegendModel(graph([]), { variant: "plan", presentOnly: true });

    expect(model.changes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.notes).toEqual([]);
  });
});

describe("the full listing", () => {
  it("keeps the web app's legend: every change state, whether present or not", () => {
    // The canvas's own legend has always listed all five under variant="plan".
    // Filtering is the panel's opt-in, not a change to what the app draws.
    const model = buildLegendModel(graph([node("a", { change: "create" })]), {
      variant: "plan",
      presentOnly: false,
    });

    expect(model.changes.map((c) => c.key)).toEqual([
      "create",
      "update",
      "delete",
      "noop",
      "impacted",
    ]);
  });

  it("still lists both line kinds, present or not", () => {
    const model = buildLegendModel(graph([node("a")]), {
      variant: "docs",
      presentOnly: false,
    });

    expect(model.edges.map((e) => e.key)).toEqual(["depends_on", "inferred"]);
  });

  it("says nothing about change on a docs diagram", () => {
    // A docs snapshot has no change data — the entries would colour nothing.
    const model = buildLegendModel(graph([node("a")]), {
      variant: "docs",
      presentOnly: false,
    });

    expect(model.changes).toEqual([]);
  });

  it("still gates the data-source note on there being one", () => {
    // This entry has always been presence-based in the canvas legend, so it
    // is not what `presentOnly` governs. Forcing it on here would change what
    // the web app draws.
    const model = buildLegendModel(graph([node("a")]), {
      variant: "docs",
      presentOnly: false,
    });

    expect(model.notes).toEqual([]);
  });
});
