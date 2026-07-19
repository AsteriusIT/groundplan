import { test } from "node:test";
import assert from "node:assert/strict";

import { parse, validateGraph, type Graph } from "@groundplan/graph-parser";

import { diff, isAllNoop } from "./diff.js";

/** Parse an in-memory `main.tf` into a docs snapshot (Producer B). */
function snapshotOf(mainTf: string, extra: Record<string, string> = {}): Graph {
  const files = [
    { path: "main.tf", content: mainTf },
    ...Object.entries(extra).map(([path, content]) => ({ path, content })),
  ];
  const { snapshot } = parse(files);
  return snapshot;
}

const BASE = `
resource "aws_s3_bucket" "logs" {
  bucket = "logs"
  acl    = "private"
}

resource "aws_kms_key" "k" {
  description = "key"
}

resource "aws_s3_bucket" "data" {
  bucket     = "data"
  kms_key_id = aws_kms_key.k.arn
}
`;

function byId(graph: Graph, id: string) {
  return graph.nodes.find((n) => n.id === id);
}

test("an unchanged repository diffs to all-noop with no ghosts", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(BASE);
  const out = diff(before, after);
  assert.equal(out.nodes.length, after.nodes.length);
  assert.ok(out.nodes.every((n) => n.change === "noop"));
  assert.ok(isAllNoop(out));
});

test("adding a resource marks it create; untouched stay noop", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(
    BASE +
      `
resource "aws_sqs_queue" "q" {
  name = "q"
}
`,
  );
  const out = diff(before, after);
  assert.equal(byId(out, "aws_sqs_queue.q")?.change, "create");
  assert.equal(byId(out, "aws_s3_bucket.logs")?.change, "noop");
  assert.ok(!isAllNoop(out));
});

test("removing a resource re-adds it as a ghost delete with former edges", () => {
  const before = snapshotOf(BASE);
  const withoutKey = BASE.replace(
    /resource "aws_kms_key" "k" \{[^}]*\}\n/,
    "",
  ).replace(/ *kms_key_id = aws_kms_key\.k\.arn\n/, "");
  const after = snapshotOf(withoutKey);

  const out = diff(before, after);
  const ghost = byId(out, "aws_kms_key.k");
  assert.equal(ghost?.change, "delete");
  // The former dependency edge (data → key) rides back in with the ghost.
  assert.ok(
    out.edges.some(
      (e) =>
        e.kind === "depends_on" &&
        e.from === "aws_s3_bucket.data" &&
        e.to === "aws_kms_key.k",
    ),
  );
  // A delete row still names what the resource had.
  assert.ok(ghost?.attribute_diff?.some((r) => r.key === "description"));
});

test("changing one attribute is an update with the correct before/after", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(BASE.replace('acl    = "private"', 'acl    = "public-read"'));
  const out = diff(before, after);
  const bucket = byId(out, "aws_s3_bucket.logs");
  assert.equal(bucket?.change, "update");
  assert.deepEqual(bucket?.attribute_diff, [
    { key: "acl", before: '"private"', after: '"public-read"' },
  ]);
});

test("reformatting produces zero update nodes", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(
    `
resource "aws_s3_bucket" "logs" {
  acl = "private"
  bucket = "logs"
}
resource "aws_kms_key" "k" { description = "key" }
resource "aws_s3_bucket" "data" {
  bucket = "data"
  kms_key_id = aws_kms_key.k.arn
}
`,
  );
  const out = diff(before, after);
  assert.ok(
    out.nodes.every((n) => n.change === "noop"),
    `expected all noop, got ${JSON.stringify(
      out.nodes.filter((n) => n.change !== "noop").map((n) => [n.id, n.change]),
    )}`,
  );
});

test("a change propagates impacted/impact_distance to dependents", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(BASE.replace('description = "key"', 'description = "rotated"'));
  const out = diff(before, after);
  const dependent = byId(out, "aws_s3_bucket.data");
  assert.equal(dependent?.change, "noop");
  assert.equal(dependent?.impacted, true);
  assert.equal(dependent?.impact_distance, 1);
});

test("the annotated output validates against the graph schema", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(BASE.replace('"private"', '"public-read"'));
  const out = diff(before, after);
  const { valid, errors } = validateGraph(out);
  assert.ok(valid, errors.join("; "));
  assert.ok(out.version >= 3);
});

test("moving a block to another file is not a change", () => {
  const before = snapshotOf(BASE);
  const after = snapshotOf(
    BASE.replace(/resource "aws_kms_key" "k" \{[^}]*\}\n/, ""),
    { "keys.tf": 'resource "aws_kms_key" "k" {\n  description = "key"\n}\n' },
  );
  const out = diff(before, after);
  assert.equal(byId(out, "aws_kms_key.k")?.change, "noop");
});

test("two 100-node snapshots diff in under 200ms", () => {
  const blocks = (salt: string): string =>
    Array.from({ length: 100 }, (_, i) => {
      const dep = i > 0 ? `  dep = aws_s3_bucket.b${i - 1}.arn\n` : "";
      return `resource "aws_s3_bucket" "b${i}" {\n  bucket = "b${i}-${salt}"\n${dep}}\n`;
    }).join("\n");
  const before = snapshotOf(blocks("old"));
  const after = snapshotOf(blocks("old").replace('"b50-old"', '"b50-new"'));
  const start = process.hrtime.bigint();
  const out = diff(before, after);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(out.nodes.filter((n) => n.change === "update").length, 1);
  assert.ok(ms < 200, `expected < 200ms, took ${ms.toFixed(1)}ms`);
});
