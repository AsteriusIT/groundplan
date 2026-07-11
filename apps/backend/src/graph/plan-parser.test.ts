import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateGraph, type Graph } from "./graph.js";
import { isTerraformPlan, parsePlanToGraph } from "./plan-parser.js";

function readJson(rel: string): unknown {
  const path = fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const name of ["simple", "modules", "replace"]) {
  test(`parses the ${name} plan into the expected golden graph`, () => {
    const plan = readJson(`plans/${name}.plan.json`);
    const expected = readJson(`graphs/${name}.graph.json`);

    const graph = parsePlanToGraph(plan);

    assert.equal(validateGraph(graph).valid, true, "output must be a valid graph");
    assert.deepEqual(graph, expected);
    // Byte-stable: parsing twice yields identical serialized output.
    assert.equal(JSON.stringify(graph), JSON.stringify(parsePlanToGraph(plan)));
  });
}

test("data resources are excluded from the plan graph", () => {
  const plan = readJson("plans/simple.plan.json");
  const graph = parsePlanToGraph(plan);
  assert.ok(
    !graph.nodes.some((n) => n.id.startsWith("data.")),
    "data resources must not appear as nodes",
  );
});

test("replace actions ([delete,create] / [create,delete]) map to update", () => {
  const graph = parsePlanToGraph(readJson("plans/replace.plan.json"));
  const web = graph.nodes.find((n) => n.id === "aws_instance.web");
  const worker = graph.nodes.find((n) => n.id === "aws_instance.worker");
  assert.equal(web?.change, "update");
  assert.equal(worker?.change, "update");
});

test("isTerraformPlan detects plans via format_version + resource_changes", () => {
  assert.equal(isTerraformPlan({ format_version: "1.2", resource_changes: [] }), true);
  assert.equal(isTerraformPlan({ hello: "world" }), false);
  assert.equal(isTerraformPlan({ format_version: "1.2" }), false);
  assert.equal(isTerraformPlan({ resource_changes: [] }), false);
  assert.equal(isTerraformPlan(null), false);
});

test("a 500-resource plan parses in under 2 seconds", () => {
  const resource_changes = Array.from({ length: 500 }, (_, i) => ({
    address: `aws_s3_bucket.b${i}`,
    mode: "managed",
    type: "aws_s3_bucket",
    name: `b${i}`,
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions: ["create"] },
  }));
  const plan = { format_version: "1.2", resource_changes };

  const start = process.hrtime.bigint();
  const graph = parsePlanToGraph(plan);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(graph.nodes.length, 500);
  assert.ok(ms < 2000, `expected < 2000ms, took ${ms.toFixed(1)}ms`);
});

test("an invalid graph would be caught by validation (empty address)", () => {
  const graph: Graph = parsePlanToGraph({
    format_version: "1.2",
    resource_changes: [
      { address: "", mode: "managed", type: "aws_s3_bucket", name: "x", change: { actions: ["create"] } },
    ],
  });
  // The parser is faithful (produces the empty id); validation is the gate.
  assert.equal(validateGraph(graph).valid, false);
});
