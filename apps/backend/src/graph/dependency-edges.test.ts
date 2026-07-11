import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDependencyEdges,
  buildInstancesByBase,
  resolveReference,
  type EdgeContext,
} from "./dependency-edges.js";

function ctx(over: Partial<EdgeContext> = {}): EdgeContext {
  const resourceIds = over.resourceIds ?? new Set<string>();
  return {
    resourceIds,
    moduleIds: over.moduleIds ?? new Set<string>(),
    instancesByBase: over.instancesByBase ?? buildInstancesByBase(resourceIds),
  };
}

test("resolveReference strips attribute suffixes to the resource address", () => {
  const c = ctx({ resourceIds: new Set(["aws_vpc.main"]) });
  assert.deepEqual(resolveReference("", "aws_vpc.main.id", c), ["aws_vpc.main"]);
  assert.deepEqual(resolveReference("", "aws_vpc.main", c), ["aws_vpc.main"]);
});

test("resolveReference skips var/local/each/count references", () => {
  const c = ctx({ resourceIds: new Set(["aws_vpc.main"]) });
  for (const ref of ["var.x", "local.y", "each.key", "count.index", "path.module"]) {
    assert.deepEqual(resolveReference("", ref, c), []);
  }
});

test("resolveReference expands a base reference to all count/for_each instances", () => {
  const c = ctx({ resourceIds: new Set(["aws_subnet.a[0]", "aws_subnet.a[1]"]) });
  assert.deepEqual(resolveReference("", "aws_subnet.a.id", c), [
    "aws_subnet.a[0]",
    "aws_subnet.a[1]",
  ]);
  // An explicit index resolves to just that instance.
  assert.deepEqual(resolveReference("", "aws_subnet.a[1].id", c), ["aws_subnet.a[1]"]);
});

test("resolveReference maps module.<name>.output to the module node", () => {
  const c = ctx({ moduleIds: new Set(["module.network"]) });
  assert.deepEqual(resolveReference("", "module.network.vnet_id", c), ["module.network"]);
  // Relative to a module scope.
  const nested = ctx({ moduleIds: new Set(["module.a.module.b"]) });
  assert.deepEqual(resolveReference("module.a.", "module.b.x", nested), [
    "module.a.module.b",
  ]);
});

test("buildDependencyEdges dedupes and lets explicit win over inferred", () => {
  const c = ctx({ resourceIds: new Set(["aws_a.x", "aws_b.y"]) });
  const edges = buildDependencyEdges(
    [
      {
        fromBase: "aws_a.x",
        prefix: "",
        refs: [
          { ref: "aws_b.y.id", inferred: true },
          { ref: "aws_b.y", inferred: false }, // explicit depends_on
        ],
      },
    ],
    c,
  );
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], {
    from: "aws_a.x",
    to: "aws_b.y",
    kind: "depends_on",
    inferred: false,
  });
});

test("buildDependencyEdges expands both sides for count resources, no self-edges", () => {
  const c = ctx({
    resourceIds: new Set(["aws_subnet.a[0]", "aws_subnet.a[1]", "aws_vpc.main"]),
  });
  const edges = buildDependencyEdges(
    [
      // A count resource that references the (single) vpc → one edge per instance.
      { fromBase: "aws_subnet.a", prefix: "", refs: [{ ref: "aws_vpc.main.id", inferred: true }] },
      // Self-reference must not produce an edge.
      { fromBase: "aws_vpc.main", prefix: "", refs: [{ ref: "aws_vpc.main", inferred: true }] },
    ],
    c,
  );
  const pairs = edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(pairs, [
    "aws_subnet.a[0]->aws_vpc.main",
    "aws_subnet.a[1]->aws_vpc.main",
  ]);
});
