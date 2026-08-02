/**
 * Assembling the catalog one composition needs (GP-238, data lookups GP-248).
 *
 * The repository is a stub because the question here is *which schemas are
 * asked for*, not how they are stored: a lookup must be described by the data
 * source's arguments, and a resource by the resource's, or the builder would
 * write a `data` block full of things a data block cannot take.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { BuilderGraph } from "@groundplan/builder";
import type { ProviderResourceSchema } from "@groundplan/builder";

import { catalogForGraph } from "./builder-catalog.js";
import type { ProviderRef } from "../catalog/providers.js";
import type { ReadyVersion } from "../catalog/repository.js";

const AZURERM: ProviderRef = { namespace: "hashicorp", name: "azurerm" };

const READY: ReadyVersion = {
  provider: AZURERM,
  versionId: "v1",
  version: "4.81.0",
  extractedAt: new Date("2026-08-01T00:00:00.000Z"),
};

/** One argument, spelled the way `terraform providers schema -json` does. */
function attribute(
  name: string,
  over: Partial<ProviderResourceSchema["attributes"][number]> = {},
): ProviderResourceSchema["attributes"][number] {
  return {
    name,
    type: "string",
    kind: "string",
    required: true,
    optional: false,
    computed: false,
    sensitive: false,
    ...over,
  };
}

function schema(
  type: string,
  kind: "resource" | "data_source",
  attributes: ProviderResourceSchema["attributes"],
): ProviderResourceSchema {
  return {
    type,
    kind,
    provider: "hashicorp/azurerm",
    version: READY.version,
    attributes,
    blocks: [],
  };
}

const SCHEMAS = {
  "resource:azurerm_container_registry": schema("azurerm_container_registry", "resource", [
    attribute("name"),
    attribute("sku_name"),
    attribute("resource_group_name"),
  ]),
  "data_source:azurerm_container_registry": schema("azurerm_container_registry", "data_source", [
    attribute("name"),
    attribute("resource_group_name"),
    // Read, never written — the reason a lookup cannot use the resource's schema.
    attribute("sku_name", { required: false, computed: true }),
  ]),
};

/** Records what was asked for, so the test can check the *questions*. */
function stubRepo() {
  const asked: string[] = [];
  return {
    asked,
    repo: {
      getLatestReadyVersion: async () => READY,
      listTypeNames: async () => ["azurerm_container_registry", "azurerm_resource_group"],
      getResourceSchemas: async (
        _versionId: string,
        types: readonly string[],
        kind: "resource" | "data_source" = "resource",
      ) => {
        for (const type of types) asked.push(`${kind}:${type}`);
        return new Map(
          types.flatMap((type) => {
            const found = SCHEMAS[`${kind}:${type}` as keyof typeof SCHEMAS];
            return found ? ([[type, found]] as const) : [];
          }),
        );
      },
    },
  };
}

/** One registry declared, and one looked up — the same type, twice. */
function bothWays(): BuilderGraph {
  return {
    nodes: [
      {
        id: "new",
        type: "azurerm_container_registry",
        name: "created",
        attributes: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "existing",
        type: "azurerm_container_registry",
        mode: "data",
        name: "found",
        attributes: {},
        position: { x: 0, y: 160 },
      },
    ],
    references: [],
  };
}

test("a lookup is read from the data source's schema, not the resource's", async () => {
  const { repo, asked } = stubRepo();
  const { catalog, versions } = await catalogForGraph(bothWays(), {
    repo,
    allowlist: [AZURERM],
  });

  assert.deepEqual(asked.sort(), [
    "data_source:azurerm_container_registry",
    "resource:azurerm_container_registry",
  ]);
  assert.equal(versions.azurerm, "4.81.0");

  const declared = catalog.find(
    (def) => def.type === "azurerm_container_registry" && (def.kind ?? "resource") === "resource",
  );
  const lookedUp = catalog.find(
    (def) => def.type === "azurerm_container_registry" && def.kind === "data_source",
  );
  assert.ok(declared, "the resource definition is there");
  assert.ok(lookedUp, "and so is the data source's, under the same type");

  // The declaration must say which SKU to create; the lookup reads it back.
  assert.ok(declared.attributes.some((a) => a.name === "sku_name"));
  assert.equal(
    lookedUp.attributes.some((a) => a.name === "sku_name"),
    false,
  );
  // Both keep the connection the naming rule derives.
  for (const def of [declared, lookedUp]) {
    assert.deepEqual(
      def.references.map((slot) => slot.attribute),
      ["resource_group_name"],
    );
  }
});

test("a curated type still needs no lookup, but its data source does", async () => {
  const { repo, asked } = stubRepo();
  const graph: BuilderGraph = {
    nodes: [
      {
        id: "rg",
        type: "azurerm_resource_group",
        mode: "data",
        name: "existing",
        attributes: {},
        position: { x: 0, y: 0 },
      },
      {
        id: "rg2",
        type: "azurerm_resource_group",
        name: "created",
        attributes: {},
        position: { x: 0, y: 160 },
      },
    ],
    references: [],
  };
  await catalogForGraph(graph, { repo, allowlist: [AZURERM] });

  // The curated dozen are compiled in — as resources. There is no hand-written
  // data source, so that one is fetched.
  assert.deepEqual(asked, ["data_source:azurerm_resource_group"]);
});
