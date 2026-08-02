import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parse } from "@groundplan/graph-parser";

import type { BuilderGraph, BuilderValue } from "./builder-graph.js";
import { addressOf } from "./builder-graph.js";
import { CATALOG, resourceDef, type ResourceDef } from "./catalog.js";
import { generateTerraform, renderVariable } from "./generate.js";
import { mergeCatalog } from "./schema-def.js";
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

// ---------------------------------------------------------------------------
// Data lookups (GP-248): the same canvas, for infrastructure that already
// exists.
// ---------------------------------------------------------------------------

/**
 * What the provider says about `data "azurerm_resource_group"`: a name to look
 * it up by, and nothing else — everything else about an existing group is read.
 * The real one comes from the catalog; this is the shape of it.
 */
const RG_LOOKUP: ResourceDef = {
  type: "azurerm_resource_group",
  kind: "data_source",
  label: "Resource group",
  description: "An existing resource group, looked up by name.",
  attributes: [
    { name: "name", label: "Name", kind: "string", required: true },
  ],
  references: [],
};

/** A network in a resource group this composition does not own. */
function withLookup(): BuilderGraph {
  return {
    nodes: [
      {
        id: "rg",
        type: "azurerm_resource_group",
        mode: "data",
        name: "existing",
        attributes: { name: "rg-platform-shared" },
        position: { x: 0, y: 0 },
      },
      {
        id: "vnet",
        type: "azurerm_virtual_network",
        name: "app",
        attributes: { name: "vnet-app", address_space: ["10.0.0.0/16"] },
        position: { x: 0, y: 160 },
      },
    ],
    references: [
      { from: "vnet", to: "rg", attribute: "resource_group_name" },
    ],
  };
}

describe("data lookups (GP-248)", () => {
  const catalog = mergeCatalog([RG_LOOKUP]);

  it("writes a data block, and addresses every reference to it through data.", () => {
    const graph = withLookup();
    assert.deepEqual(validateBuilderGraph(graph, catalog), []);

    const files = new Map(
      generateTerraform(graph, { catalog }).map((f) => [f.path, f.content]),
    );
    // The lookup lands where its resource counterpart would, not in a file of
    // its own — a curated type keeps its file whichever way it is read.
    assert.match(
      files.get("main.tf") ?? "",
      /data "azurerm_resource_group" "existing" \{\n {2}name = "rg-platform-shared"\n\}/,
    );
    // Nothing declares the group: it is somebody else's, and Terraform is only
    // being told where to find it.
    assert.doesNotMatch(files.get("main.tf") ?? "", /resource "azurerm_resource_group"/);
    assert.match(
      files.get("network.tf") ?? "",
      /resource_group_name = data\.azurerm_resource_group\.existing\.name/,
    );
  });

  it("holds the golden invariant", () => {
    const graph = withLookup();
    const { snapshot, diagnostics } = parse(generateTerraform(graph, { catalog }));
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    // Producer B reads a data block as `data.<type>.<name>`, which is exactly
    // the address the builder composed it under.
    assert.deepEqual(
      snapshot.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)),
      [
        "azurerm_virtual_network.app",
        "data.azurerm_resource_group.existing",
      ],
    );
    assert.deepEqual(
      snapshot.edges
        .filter((e) => e.kind === "depends_on")
        .map((e) => `${e.from} -> ${e.to}`),
      ["azurerm_virtual_network.app -> data.azurerm_resource_group.existing"],
    );
  });

  it("judges a lookup by the data source's arguments, not the resource's", () => {
    const graph = withLookup();
    const rg = graph.nodes[0]!;
    // A resource group *resource* is declared somewhere; an existing one simply
    // is somewhere, and `data "azurerm_resource_group"` takes no location at
    // all — writing one would produce a file Terraform rejects.
    const located = {
      ...rg,
      attributes: { ...rg.attributes, location: "westeurope" },
    };

    assert.deepEqual(
      validateBuilderGraph(
        { ...graph, nodes: [located, ...graph.nodes.slice(1)] },
        catalog,
      ).map((i) => `${i.reason}: ${i.message}`),
      ['unknown_attribute: Resource group has no attribute "location"'],
    );
    // The very same node, declared rather than looked up, is fine.
    assert.deepEqual(
      validateBuilderGraph(
        {
          ...graph,
          nodes: [{ ...located, mode: "resource" }, ...graph.nodes.slice(1)],
        },
        catalog,
      ),
      [],
    );
  });

  it("refuses a lookup of a type it has no data source for", () => {
    const graph: BuilderGraph = {
      nodes: [
        {
          id: "vm",
          type: "azurerm_linux_virtual_machine",
          mode: "data",
          name: "existing",
          attributes: {},
          position: { x: 0, y: 0 },
        },
      ],
      references: [],
    };
    assert.deepEqual(
      validateBuilderGraph(graph, catalog).map((i) => i.message),
      ['"azurerm_linux_virtual_machine" is not a data source the builder can read'],
    );
  });

  it("lets a lookup and a resource of one type share a name", () => {
    const graph: BuilderGraph = {
      nodes: [
        {
          id: "a",
          type: "azurerm_resource_group",
          mode: "data",
          name: "shared",
          attributes: { name: "rg-existing" },
          position: { x: 0, y: 0 },
        },
        {
          id: "b",
          type: "azurerm_resource_group",
          name: "shared",
          attributes: { name: "rg-new", location: "westeurope" },
          position: { x: 0, y: 160 },
        },
      ],
      references: [],
    };
    // `data.azurerm_resource_group.shared` and `azurerm_resource_group.shared`
    // are two different addresses, and Terraform is happy with both.
    assert.deepEqual(validateBuilderGraph(graph, catalog), []);

    const clash: BuilderGraph = {
      ...graph,
      nodes: [graph.nodes[0]!, { ...graph.nodes[0]!, id: "c" }],
    };
    assert.deepEqual(
      validateBuilderGraph(clash, catalog).map((i) => i.reason),
      ["duplicate_name", "duplicate_name"],
    );
  });
});

// ---------------------------------------------------------------------------
// Variables (GP-249): the values a composition takes in, and the arguments
// that point at them instead of carrying a literal.
// ---------------------------------------------------------------------------

/** A location everything shares, a network in a group somebody else owns. */
function parameterised(): BuilderGraph {
  return {
    nodes: [
      {
        id: "loc",
        type: "",
        mode: "variable",
        name: "location",
        attributes: {
          type: "string",
          description: "Where everything goes",
          default: "westeurope",
        },
        position: { x: 0, y: 0 },
      },
      {
        id: "rgname",
        type: "",
        mode: "variable",
        name: "resource_group",
        attributes: { type: "string" },
        position: { x: 0, y: 120 },
      },
      {
        id: "vnet",
        type: "azurerm_virtual_network",
        name: "app",
        attributes: {
          name: "vnet-app",
          location: "eastus",
          address_space: ["10.0.0.0/16"],
        },
        position: { x: 0, y: 240 },
      },
    ],
    references: [
      // An ordinary argument, pointed at a variable…
      { from: "vnet", to: "loc", attribute: "location" },
      // …and a typed slot, pointed at one too.
      { from: "vnet", to: "rgname", attribute: "resource_group_name" },
    ],
  };
}

describe("variables (GP-249)", () => {
  it("writes variables.tf, with the type unquoted", () => {
    const graph = parameterised();
    assert.deepEqual(validateBuilderGraph(graph), []);

    const files = filesOf(graph);
    assert.equal(
      files.get("variables.tf"),
      [
        'variable "location" {',
        "  type        = string",
        '  description = "Where everything goes"',
        '  default     = "westeurope"',
        "}",
        "",
        'variable "resource_group" {',
        "  type = string",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("points an argument and a slot at a variable, and never at var.x.id", () => {
    const network = filesOf(parameterised()).get("network.tf") ?? "";
    // The literal the node still carries is not what is written.
    assert.match(network, /location {12}= var\.location/);
    assert.doesNotMatch(network, /"eastus"/);
    assert.match(network, /resource_group_name = var\.resource_group/);
    // A variable is the whole expression: there is nothing to read off it.
    assert.doesNotMatch(network, /var\.\w+\./);
  });

  it("renders a default as the type it declared", () => {
    const of = (attributes: Record<string, BuilderValue>) =>
      renderVariable({
        id: "v",
        type: "",
        mode: "variable",
        name: "v",
        attributes,
        position: { x: 0, y: 0 },
      });

    assert.match(of({ type: "number", default: 3 }), /default = 3\n/);
    assert.match(of({ type: "bool", default: true }), /default = true\n/);
    assert.match(
      of({ type: "list(string)", default: ["a", "b"] }),
      /default = \["a", "b"\]\n/,
    );
    // Terraform's own default, so saying it would be noise.
    assert.doesNotMatch(of({ type: "string", sensitive: false }), /sensitive/);
    assert.match(of({ type: "string", sensitive: true }), /sensitive = true/);
    // No default at all is a variable somebody must supply, which is a choice.
    assert.doesNotMatch(of({ type: "string" }), /default/);
  });

  it("checks a default against the type the variable declared", () => {
    const graph: BuilderGraph = {
      nodes: [
        {
          id: "v",
          type: "",
          mode: "variable",
          name: "replicas",
          attributes: { type: "number", default: "three" },
          position: { x: 0, y: 0 },
        },
      ],
      references: [],
    };
    assert.deepEqual(
      validateBuilderGraph(graph).map((i) => `${i.attribute}: ${i.message}`),
      ["default: Default must be a number"],
    );
  });

  it("refuses two variables of one name, and allows a resource to share it", () => {
    const one = (id: string, name: string): BuilderGraph["nodes"][number] => ({
      id,
      type: "",
      mode: "variable",
      name,
      attributes: { type: "string" },
      position: { x: 0, y: 0 },
    });
    const clash: BuilderGraph = {
      nodes: [one("a", "location"), one("b", "location")],
      references: [],
    };
    assert.deepEqual(
      validateBuilderGraph(clash).map((i) => i.reason),
      ["duplicate_name", "duplicate_name"],
    );

    // `var.location` and `azurerm_resource_group.location` are two addresses.
    const beside: BuilderGraph = {
      nodes: [
        one("a", "location"),
        {
          id: "rg",
          type: "azurerm_resource_group",
          name: "location",
          attributes: { name: "rg-x", location: "westeurope" },
          position: { x: 0, y: 0 },
        },
      ],
      references: [],
    };
    assert.deepEqual(validateBuilderGraph(beside), []);
  });

  it("refuses to point an argument at anything but a variable", () => {
    const graph = parameterised();
    const wrong: BuilderGraph = {
      ...graph,
      references: [{ from: "vnet", to: "rgname", attribute: "name" }],
    };
    assert.deepEqual(
      validateBuilderGraph({
        ...wrong,
        nodes: wrong.nodes.map((n) =>
          n.id === "rgname" ? { ...n, mode: undefined, type: "azurerm_resource_group" } : n,
        ),
      })
        .filter((i) => i.nodeId === "vnet" && i.reason === "wrong_target_type")
        .map((i) => i.message),
      ["Azure name can only be given a value or a variable"],
    );
  });

  it("holds the golden invariant, variables and all", () => {
    const graph = parameterised();
    const { snapshot, diagnostics } = parse(generateTerraform(graph));
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error"),
      [],
    );
    // A variable is not infrastructure, so the diagram has one node: the
    // network. `var.x` is a value, not a dependency, and is drawn as neither.
    assert.deepEqual(
      snapshot.nodes.map((n) => n.id),
      ["azurerm_virtual_network.app"],
    );
    assert.deepEqual(
      snapshot.edges.filter((e) => e.kind === "depends_on"),
      [],
    );
  });
});
