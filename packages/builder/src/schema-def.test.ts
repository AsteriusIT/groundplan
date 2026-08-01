/**
 * Provider schema → builder definition (GP-238).
 *
 * The load-bearing test is `reproduces the curated connections`: the reference
 * rule is a heuristic about names, and the only honest way to know whether it
 * works is to run it against a real provider and compare it with connections a
 * person wrote by hand. It passes because Terraform's own naming convention is
 * consistent — and if a future provider version breaks that, this test says so
 * rather than the builder quietly drawing the wrong arrows.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { BuilderGraph } from "./builder-graph.js";
import { CATALOG, resourceDef } from "./catalog.js";
import { generateTerraform } from "./generate.js";
import { parseProviderSchema, type RawProvidersSchema } from "./provider-schema-parse.js";
import {
  isWritable,
  labelForType,
  mergeCatalog,
  referenceTarget,
  resourceDefFromSchema,
  typeNamesOf,
} from "./schema-def.js";
import { validateBuilderGraph } from "./validate.js";

const SCHEMAS = parseProviderSchema(
  JSON.parse(
    readFileSync(
      new URL("./__fixtures__/azurerm-4.81.0-subset.json", import.meta.url),
      "utf8",
    ),
  ) as RawProvidersSchema,
  { provider: "hashicorp/azurerm", version: "4.81.0" },
);

const TYPES = typeNamesOf(SCHEMAS);

function schemaOf(type: string) {
  const schema = SCHEMAS.find((s) => s.type === type && s.kind === "resource");
  assert.ok(schema, `fixture is missing ${type}`);
  return schema;
}

const defOf = (type: string) => resourceDefFromSchema(schemaOf(type), TYPES);

describe("what a schema offers (GP-238)", () => {
  test("an output nobody may write is not a field", () => {
    assert.equal(
      isWritable({
        name: "fqdn",
        type: "string",
        kind: "string",
        required: false,
        optional: false,
        computed: true,
        sensitive: false,
      }),
      false,
    );
    // `optional && computed` is "set it, or the provider decides" — a field.
    assert.equal(
      isWritable({
        name: "sku",
        type: "string",
        kind: "string",
        required: false,
        optional: true,
        computed: true,
        sensitive: false,
      }),
      true,
    );
  });

  test("`id` is never offered, whatever the provider says", () => {
    const subnet = defOf("azurerm_subnet");
    assert.equal(
      subnet.attributes.some((a) => a.name === "id"),
      false,
    );
  });

  test("a structure is left out rather than given a text box it cannot fill", () => {
    // `tags` is `map(string)`; a BuilderValue is a scalar or a list of strings,
    // so offering a field for it would generate HCL that does not parse.
    const vault = defOf("azurerm_key_vault");
    assert.equal(
      vault.attributes.some((a) => a.name === "tags"),
      false,
    );
  });

  test("the provider's sensitive flag reaches the form", () => {
    // The builder writes literals into a file somebody is about to commit, so
    // a field the provider calls sensitive has to arrive at the form saying so.
    const vm = defOf("azurerm_linux_virtual_machine");
    assert.equal(
      vm.attributes.find((a) => a.name === "admin_password")?.sensitive,
      true,
    );
    assert.equal(
      vm.attributes.find((a) => a.name === "admin_username")?.sensitive,
      undefined,
    );
  });

  test("a block the provider requires becomes part of the scaffold", () => {
    const subnet = defOf("azurerm_subnet");
    // `delegation` is optional on a subnet, so it is not scaffolded — only a
    // block the provider says must be present is.
    assert.equal(
      (subnet.blocks ?? []).some((b) => b.name === "delegation"),
      false,
    );

    const vm = defOf("azurerm_linux_virtual_machine");
    assert.ok(
      (vm.blocks ?? []).some((b) => b.name === "os_disk"),
      "os_disk is required on a Linux VM",
    );
  });

  test("an argument that exists twice cannot overwrite itself", () => {
    // A Kubernetes cluster has a `name`, and so does its required
    // `default_node_pool` block. They are two fields, they are labelled apart,
    // and they are stored apart — but both still generate as `name`.
    const cluster = defOf("azurerm_kubernetes_cluster");
    const names = cluster.attributes.filter((a) => a.name === "name");
    assert.equal(names.length, 2);
    assert.equal(new Set(names.map((a) => a.key ?? a.name)).size, 2);
    assert.equal(new Set(names.map((a) => a.label)).size, 2);
    assert.ok(names.some((a) => a.block === "default_node_pool"));
  });

  test("the generated HCL still says the argument's real name", () => {
    const cluster = defOf("azurerm_kubernetes_cluster");
    const node = {
      id: "n1",
      type: cluster.type,
      name: "platform",
      attributes: {
        name: "aks-platform",
        location: "westeurope",
        "default_node_pool.name": "system",
      },
      position: { x: 0, y: 0 },
    };
    const files = generateTerraform(
      { nodes: [node], references: [] },
      { catalog: [cluster] },
    );
    const content = files.map((f) => f.content).join("\n");
    assert.match(content, /name\s+= "aks-platform"/);
    assert.match(content, /default_node_pool \{[\s\S]*name\s+= "system"/);
    // The qualified key is a storage detail; it must never reach the file.
    assert.equal(content.includes("default_node_pool.name ="), false);
  });

  test("a label reads like a person wrote it", () => {
    assert.equal(labelForType("azurerm_subnet"), "Subnet");
    assert.equal(
      labelForType("azurerm_linux_virtual_machine"),
      "Linux virtual machine",
    );
  });
});

describe("the reference rule (GP-238)", () => {
  test("recognises the three shapes a Terraform reference takes", () => {
    const attribute = (name: string, kind: "string" | "list") => ({
      name,
      type: kind === "list" ? "list(string)" : "string",
      kind,
      required: true,
      optional: false,
      computed: false,
      sensitive: false,
    });

    assert.deepEqual(referenceTarget(attribute("subnet_id", "string"), "azurerm"), {
      type: "azurerm_subnet",
      targetAttribute: "id",
      list: false,
    });
    assert.deepEqual(
      referenceTarget(attribute("resource_group_name", "string"), "azurerm"),
      { type: "azurerm_resource_group", targetAttribute: "name", list: false },
    );
    assert.deepEqual(
      referenceTarget(attribute("network_interface_ids", "list"), "azurerm"),
      { type: "azurerm_network_interface", targetAttribute: "id", list: true },
    );
    // A name that is not one of the shapes is a plain field.
    assert.equal(referenceTarget(attribute("location", "string"), "azurerm"), null);
    // And a shape whose kind does not match is not one either.
    assert.equal(referenceTarget(attribute("subnet_id", "list"), "azurerm"), null);
  });

  test("only points at types the provider actually has", () => {
    const subnet = schemaOf("azurerm_subnet");
    // `service_endpoint_policy_ids` looks like a reference, and would be one —
    // but `azurerm_service_endpoint_policy` is not in this fixture, so the rule
    // must leave it as a field rather than invent a type.
    const withoutPolicies = resourceDefFromSchema(subnet, TYPES);
    assert.equal(
      withoutPolicies.references.some(
        (r) => r.attribute === "service_endpoint_policy_ids",
      ),
      false,
    );

    const withPolicies = resourceDefFromSchema(
      subnet,
      new Set([...TYPES, "azurerm_service_endpoint_policy"]),
    );
    assert.deepEqual(
      withPolicies.references.find(
        (r) => r.attribute === "service_endpoint_policy_ids",
      )?.targetTypes,
      ["azurerm_service_endpoint_policy"],
    );
  });

  /**
   * The one connection in the curated catalog that no naming rule can find.
   * `private_connection_resource_id` is polymorphic — it points at a storage
   * account *or* a key vault *or* a dozen other services — so the name says
   * "some resource" and the type it means is not in it. Naming it here is the
   * honest form of the claim below: everything else is derivable, and this is
   * why curation still exists.
   */
  const POLYMORPHIC = new Set([
    "azurerm_private_endpoint.private_connection_resource_id",
  ]);

  test("reproduces the curated connections, from the real provider schema", () => {
    // The claim the whole story rests on. Every connection somebody wrote by
    // hand must also fall out of the schema alone — same attribute, same
    // target, same target attribute, same arity — because if the derivation
    // cannot rediscover twelve hand-checked resources, it has no business
    // drawing arrows on fifteen hundred nobody has checked.
    const curatedTypes = CATALOG.filter((def) => TYPES.has(def.type));
    assert.equal(
      curatedTypes.length,
      CATALOG.length,
      "the fixture must cover every curated type",
    );

    let compared = 0;
    for (const curated of curatedTypes) {
      const derived = defOf(curated.type);
      for (const slot of curated.references) {
        if (POLYMORPHIC.has(`${curated.type}.${slot.attribute}`)) continue;
        const found = derived.references.find(
          (r) => r.attribute === slot.attribute,
        );
        assert.ok(
          found,
          `${curated.type}.${slot.attribute} is curated but not derivable`,
        );
        assert.deepEqual(
          found.targetTypes,
          slot.targetTypes,
          `${curated.type}.${slot.attribute} points elsewhere`,
        );
        assert.equal(found.targetAttribute, slot.targetAttribute);
        assert.equal(Boolean(found.list), Boolean(slot.list));
        compared += 1;
      }
    }
    assert.ok(compared >= 15, `only ${compared} connections were compared`);
  });

  test("derives connections nobody curated, and none that point nowhere", () => {
    // The other half: across every type in the fixture, a derived slot must
    // always name a type the provider actually has. An arrow to a resource
    // that does not exist is worse than no arrow.
    let derivedSlots = 0;
    for (const type of TYPES) {
      for (const slot of defOf(type).references) {
        derivedSlots += 1;
        for (const target of slot.targetTypes) {
          assert.ok(TYPES.has(target), `${type}.${slot.attribute} → ${target}`);
        }
      }
    }
    assert.ok(derivedSlots > 20, "the rule should find more than the curated few");
  });

  test("a slot inside a required block keeps the block it belongs to", () => {
    const vm = defOf("azurerm_linux_virtual_machine");
    const nics = vm.references.find(
      (r) => r.attribute === "network_interface_ids",
    );
    assert.ok(nics);
    assert.equal(nics.block, undefined);
    assert.equal(nics.list, true);
  });
});

describe("mergeCatalog (GP-238)", () => {
  test("prefers the curated entry, and keeps every derived one", () => {
    const derived = SCHEMAS.filter((s) => s.kind === "resource").map((s) =>
      resourceDefFromSchema(s, TYPES),
    );
    const merged = mergeCatalog(derived);

    // Curated wins: the label, the category and the scaffold blocks a person
    // wrote are what a first-time user meets.
    const subnet = resourceDef("azurerm_subnet", merged);
    assert.equal(subnet, resourceDef("azurerm_subnet", CATALOG));
    assert.equal(subnet?.category, "network");

    // And a type nobody curated is there too, which is the point.
    const cluster = resourceDef("azurerm_kubernetes_cluster", merged);
    assert.ok(cluster);
    assert.equal(cluster.category, undefined);
    assert.equal(cluster.file, "azurerm.tf");

    // Every curated type survives the merge, none twice.
    assert.equal(
      new Set(merged.map((d) => d.type)).size,
      merged.length,
    );
    for (const def of CATALOG) {
      assert.ok(resourceDef(def.type, merged), `${def.type} was lost`);
    }
  });
});

describe("composing a derived type (GP-238)", () => {
  const derived = SCHEMAS.filter((s) => s.kind === "resource").map((s) =>
    resourceDefFromSchema(s, TYPES),
  );
  const catalog = mergeCatalog(derived);

  /** A resource group and a cluster connected to it — nothing curated. */
  const graph: BuilderGraph = {
    nodes: [
      {
        id: "rg",
        type: "azurerm_resource_group",
        name: "platform",
        attributes: { name: "rg-platform", location: "westeurope" },
        position: { x: 0, y: 0 },
      },
      {
        id: "aks",
        type: "azurerm_kubernetes_cluster",
        name: "platform",
        attributes: {
          name: "aks-platform",
          location: "westeurope",
          dns_prefix: "platform",
        },
        position: { x: 0, y: 0 },
      },
    ],
    references: [
      { from: "aks", to: "rg", attribute: "resource_group_name" },
    ],
  };

  test("validates against the provider's own requirements", () => {
    const issues = validateBuilderGraph(graph, catalog);
    // Whatever is missing must be named by the provider, never invented: every
    // issue has to point at an attribute the schema actually declares.
    const schema = schemaOf("azurerm_kubernetes_cluster");
    // Every argument the provider declares, at the top level or inside one of
    // its blocks — the latter under the qualified key the form stores them by.
    const known = new Set([
      ...schema.attributes.map((a) => a.name),
      ...schema.blocks.flatMap((b) => [
        b.name,
        ...b.attributes.map((a) => `${b.name}.${a.name}`),
      ]),
    ]);
    for (const issue of issues.filter((i) => i.nodeId === "aks")) {
      if (!issue.attribute) continue;
      assert.ok(
        known.has(issue.attribute),
        `${issue.attribute} is not an argument of the resource`,
      );
    }
  });

  test("blocks an attribute the provider does not have", () => {
    const issues = validateBuilderGraph(
      {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === "aks"
            ? { ...n, attributes: { ...n.attributes, not_a_thing: "x" } }
            : n,
        ),
      },
      catalog,
    );
    assert.ok(
      issues.some(
        (i) => i.reason === "unknown_attribute" && i.attribute === "not_a_thing",
      ),
    );
  });

  test("generates into the provider's file, with the version it read", () => {
    const files = generateTerraform(graph, {
      catalog,
      versions: { azurerm: "4.81.0" },
    });
    const paths = files.map((f) => f.path);
    assert.deepEqual(paths, ["main.tf", "azurerm.tf"]);

    const main = files.find((f) => f.path === "main.tf")?.content ?? "";
    // The curated resource group keeps its curated file; the derived cluster
    // goes to the provider's.
    assert.match(main, /resource "azurerm_resource_group" "platform"/);
    assert.match(main, /version = "~> 4\.0"/);

    const azurerm = files.find((f) => f.path === "azurerm.tf")?.content ?? "";
    assert.match(azurerm, /resource "azurerm_kubernetes_cluster" "platform"/);
    // The connection is a reference, never a copied string.
    assert.match(
      azurerm,
      /resource_group_name\s+= azurerm_resource_group\.platform\.name/,
    );
  });

  test("is deterministic: the same composition is the same bytes", () => {
    const once = generateTerraform(graph, { catalog });
    const twice = generateTerraform(graph, { catalog });
    assert.deepEqual(once, twice);
  });
});
