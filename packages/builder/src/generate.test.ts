import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parse } from "@groundplan/graph-parser";

import type { BuilderGraph } from "./builder-graph.js";
import { addressOf } from "./builder-graph.js";
import { CATALOG, resourceDef } from "./catalog.js";
import { generateTerraform } from "./generate.js";
import { validateBuilderGraph } from "./validate.js";
import { demoGraph } from "./__fixtures__/demo-graph.js";

/** The generated set as a path → content map. */
function filesOf(graph: BuilderGraph): Map<string, string> {
  return new Map(generateTerraform(graph).map((f) => [f.path, f.content]));
}

describe("generateTerraform (GP-134)", () => {
  it("writes the provider preamble into main.tf, beside the resource group", () => {
    const main = filesOf(demoGraph()).get("main.tf") ?? "";
    assert.match(main, /terraform \{/);
    assert.match(main, /source {2}= "hashicorp\/azurerm"/);
    assert.match(main, /provider "azurerm" \{\n {2}features \{\}\n\}/);
    assert.match(main, /resource "azurerm_resource_group" "this" \{/);
    // Nothing that could be mistaken for a credential (ADR #1).
    assert.doesNotMatch(main, /client_secret|subscription_id|tenant_id\s*=/);
  });

  it("groups resources into a file per category", () => {
    const files = filesOf(demoGraph());
    assert.deepEqual([...files.keys()], ["main.tf", "network.tf", "compute.tf"]);
    assert.match(files.get("network.tf") ?? "", /resource "azurerm_subnet" "app"/);
    assert.match(
      files.get("compute.tf") ?? "",
      /resource "azurerm_linux_virtual_machine" "app"/,
    );
    // A category with nothing in it produces no file at all.
    assert.equal(files.has("data.tf"), false);
  });

  it("renders references as references, never as copied strings", () => {
    const network = filesOf(demoGraph()).get("network.tf") ?? "";
    assert.match(network, /virtual_network_name = azurerm_virtual_network\.this\.name/);
    assert.match(network, /subnet_id {21}= azurerm_subnet\.app\.id/);
  });

  it("renders a list slot as a list", () => {
    const compute = filesOf(demoGraph()).get("compute.tf") ?? "";
    assert.match(
      compute,
      /network_interface_ids = \[azurerm_network_interface\.app\.id\]/,
    );
  });

  it("renders values by kind, and aligns like terraform fmt", () => {
    const network = filesOf(demoGraph()).get("network.tf") ?? "";
    assert.match(network, /address_prefixes {5}= \["10\.0\.1\.0\/24"\]/);
    const block = network.slice(network.indexOf('resource "azurerm_subnet"'));
    const equals = block
      .split("\n")
      .slice(1, 5)
      .map((line) => line.indexOf("="));
    assert.equal(new Set(equals).size, 1, block);
  });

  it("substitutes ${attr:…} inside a scaffold block", () => {
    const compute = filesOf(demoGraph()).get("compute.tf") ?? "";
    assert.match(compute, /admin_ssh_key \{\n {4}username {3}= "azureuser"/);
    assert.match(compute, /public_key = file\("~\/\.ssh\/id_rsa\.pub"\)/);
  });

  it("renders a block with nothing in it as an empty block", () => {
    const graph: BuilderGraph = {
      nodes: [
        ...demoGraph().nodes,
        {
          id: "plan",
          type: "azurerm_service_plan",
          name: "this",
          attributes: { name: "asp-demo", location: "westeurope" },
          position: { x: 0, y: 0 },
        },
        {
          id: "app",
          type: "azurerm_linux_web_app",
          name: "this",
          attributes: { name: "app-demo", location: "westeurope" },
          position: { x: 0, y: 0 },
        },
      ],
      references: [
        ...demoGraph().references,
        { from: "plan", to: "rg", attribute: "resource_group_name" },
        { from: "app", to: "rg", attribute: "resource_group_name" },
        { from: "app", to: "plan", attribute: "service_plan_id" },
      ],
    };
    assert.deepEqual(validateBuilderGraph(graph), []);
    assert.match(filesOf(graph).get("compute.tf") ?? "", /site_config \{\}/);
  });

  it("is byte-deterministic — twice over, and however the nodes were ordered", () => {
    const graph = demoGraph();
    assert.deepEqual(generateTerraform(graph), generateTerraform(graph));

    const shuffled: BuilderGraph = {
      nodes: [...graph.nodes].reverse(),
      references: [...graph.references].reverse(),
    };
    // Canvas positions are the user's arrangement, not part of the code.
    for (const node of shuffled.nodes) node.position = { x: 999, y: -12 };
    assert.deepEqual(generateTerraform(shuffled), generateTerraform(graph));
  });

  it("skips a type the catalog does not know instead of inventing HCL", () => {
    const graph = demoGraph();
    graph.nodes.push({
      id: "x",
      type: "aws_instance",
      name: "web",
      attributes: {},
      position: { x: 0, y: 0 },
    });
    const all = generateTerraform(graph)
      .map((f) => f.content)
      .join("\n");
    assert.doesNotMatch(all, /aws_instance/);
  });
});

describe("the golden invariant (GP-134)", () => {
  // The correctness check of the whole epic: what Producer B reads back out of
  // the generated files must be the graph that was composed — same resources,
  // same references. The diagram they built is the diagram they get.
  it("parses back into the composed nodes and reference edges", () => {
    const graph = demoGraph();
    assert.deepEqual(validateBuilderGraph(graph), []);

    const { snapshot, diagnostics } = parse(generateTerraform(graph));
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
    );

    assert.deepEqual(
      snapshot.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)),
      graph.nodes.map(addressOf).sort((a, b) => a.localeCompare(b)),
    );

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const composed = new Set(
      graph.references.map((r) => {
        const from = byId.get(r.from);
        const to = byId.get(r.to);
        return `${from ? addressOf(from) : r.from} -> ${to ? addressOf(to) : r.to}`;
      }),
    );
    const parsed = new Set(
      snapshot.edges
        .filter((e) => e.kind === "depends_on")
        .map((e) => `${e.from} -> ${e.to}`),
    );
    assert.deepEqual([...parsed].sort(), [...composed].sort());
  });

  it("holds for every type in the catalog", () => {
    // One node per catalog type, wired through every required slot, so no type
    // can quietly generate HCL the parser cannot read back.
    const nodes = CATALOG.map((def, index) => ({
      id: def.type,
      type: def.type,
      name: "this",
      attributes: {} as Record<string, never>,
      position: { x: 0, y: index * 120 },
    }));
    const byType = new Map(nodes.map((n) => [n.type, n]));
    const references = CATALOG.flatMap((def) =>
      def.references.flatMap((slot) => {
        const target = slot.targetTypes
          .map((type) => byType.get(type))
          .find((node) => node !== undefined);
        return target
          ? [{ from: def.type, to: target.id, attribute: slot.attribute }]
          : [];
      }),
    );
    const graph: BuilderGraph = { nodes, references };

    // Every attribute the catalog cannot default is filled with a plausible
    // literal, exactly as the form would make the user do.
    for (const node of graph.nodes) {
      const def = resourceDef(node.type);
      assert.ok(def);
      for (const attribute of def.attributes) {
        if (attribute.default !== undefined) continue;
        Object.assign(node.attributes, {
          [attribute.name]:
            attribute.kind === "list" ? ["10.0.0.0/24"] : `${node.type}-value`,
        });
      }
    }
    assert.deepEqual(validateBuilderGraph(graph), []);

    const { snapshot, diagnostics } = parse(generateTerraform(graph));
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    assert.deepEqual(
      snapshot.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)),
      graph.nodes.map(addressOf).sort((a, b) => a.localeCompare(b)),
    );

    const composed = new Set(
      references.map((r) => `${r.from}.this -> ${r.to}.this`),
    );
    const parsed = new Set(
      snapshot.edges
        .filter((e) => e.kind === "depends_on")
        .map((e) => `${e.from} -> ${e.to}`),
    );
    assert.deepEqual([...parsed].sort(), [...composed].sort());
  });
});
