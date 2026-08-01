/**
 * Resources the catalog does not describe (GP-133 follow-up): the escape hatch
 * for the type nobody curated. Everything about them is the user's word — so
 * the checks are syntax, and generation writes exactly what was typed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parse } from "@groundplan/graph-parser";

import type { BuilderGraph, BuilderNode } from "./builder-graph.js";
import { generateTerraform } from "./generate.js";
import { isTypeIssue, validateBuilderGraph } from "./validate.js";

function custom(
  id: string,
  type: string,
  name: string,
  attributes: BuilderNode["attributes"] = {},
): BuilderNode {
  return { id, type, name, attributes, custom: true, position: { x: 0, y: 0 } };
}

/** A resource group and a custom lock pointing at it. */
function graphWithCustom(): BuilderGraph {
  return {
    nodes: [
      {
        id: "rg",
        type: "azurerm_resource_group",
        name: "this",
        attributes: { name: "rg-demo", location: "westeurope" },
        position: { x: 0, y: 0 },
      },
      custom("lock", "azurerm_management_lock", "cannot_delete", {
        name: "keep",
        lock_level: "CanNotDelete",
      }),
    ],
    references: [
      {
        from: "lock",
        to: "rg",
        attribute: "scope",
        targetAttribute: "id",
      },
    ],
  };
}

describe("custom resources", () => {
  it("accepts a type the catalog never heard of", () => {
    assert.deepEqual(validateBuilderGraph(graphWithCustom()), []);
  });

  it("still refuses an unknown type on a non-custom node", () => {
    const graph = graphWithCustom();
    delete graph.nodes[1]!.custom;
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => i.reason),
      ["unknown_type"],
    );
  });

  it("asks for a Terraform type that could exist", () => {
    const graph = graphWithCustom();
    graph.nodes[1]!.type = "Not A Type";
    const issue = validateBuilderGraph(graph)[0];
    assert.ok(issue && isTypeIssue(issue));
    assert.match(issue.message, /not a Terraform resource type/);
  });

  it("says so when the type is simply missing", () => {
    const graph = graphWithCustom();
    graph.nodes[1]!.type = "";
    assert.match(
      validateBuilderGraph(graph)[0]?.message ?? "",
      /needs a Terraform type/,
    );
  });

  it("needs both ends of a reference named", () => {
    const graph = graphWithCustom();
    delete graph.references[0]!.targetAttribute;
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => [i.attribute, i.reason]),
      [["scope", "invalid_value"]],
    );
  });

  it("reports a reference to a resource that is not on the canvas", () => {
    const graph = graphWithCustom();
    graph.references[0]!.to = "ghost";
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => i.reason),
      ["dangling_reference"],
    );
  });

  it("generates into custom.tf, references and all", () => {
    const files = new Map(
      generateTerraform(graphWithCustom()).map((f) => [f.path, f.content]),
    );
    assert.deepEqual([...files.keys()], ["main.tf", "custom.tf"]);
    assert.equal(
      files.get("custom.tf"),
      [
        'resource "azurerm_management_lock" "cannot_delete" {',
        '  lock_level = "CanNotDelete"',
        '  name       = "keep"',
        "  scope      = azurerm_resource_group.this.id",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("is deterministic however the attributes were typed in", () => {
    const graph = graphWithCustom();
    const reordered = graphWithCustom();
    reordered.nodes[1]!.attributes = {
      lock_level: "CanNotDelete",
      name: "keep",
    };
    assert.deepEqual(generateTerraform(reordered), generateTerraform(graph));
  });

  it("holds the golden invariant — Producer B reads back what was composed", () => {
    const graph = graphWithCustom();
    const { snapshot, diagnostics } = parse(generateTerraform(graph));
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    assert.deepEqual(
      snapshot.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)),
      ["azurerm_management_lock.cannot_delete", "azurerm_resource_group.this"],
    );
    assert.deepEqual(
      snapshot.edges
        .filter((e) => e.kind === "depends_on")
        .map((e) => `${e.from} -> ${e.to}`),
      ["azurerm_management_lock.cannot_delete -> azurerm_resource_group.this"],
    );
  });
});
