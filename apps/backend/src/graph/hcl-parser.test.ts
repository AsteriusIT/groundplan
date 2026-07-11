import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateGraph } from "./graph.js";
import { parseHclRepo, type HclFile } from "./hcl-parser.js";

/** Read a committed fixture repo directory into a flat list of files. */
function readRepo(rel: string): HclFile[] {
  const root = fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url));
  const out: HclFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = `${dir}/${name}`;
      const path = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, path);
      else out.push({ path, content: readFileSync(abs, "utf8") });
    }
  };
  walk(root, "");
  return out;
}

function readJson(rel: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), "utf8"),
  );
}

test("parses the fixture repo (root + local module) into the expected graph", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  assert.equal(validateGraph(graph).valid, true);
  assert.deepEqual(graph, readJson("graphs/hcl-repo.graph.json"));
});

test("a registry module source becomes a single leaf node (no recursion)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  const registry = graph.nodes.filter((n) => n.id.startsWith("module.vpc_registry"));
  assert.equal(registry.length, 1, "registry module → exactly one node");
  assert.equal(registry[0]?.type, "module");
});

test("an unparseable .tf file is skipped with a warning; the rest still parse", () => {
  const { graph, warnings } = parseHclRepo(readRepo("hcl-repo"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /broken\.tf/);
  // The broken resource is absent, but valid resources are present.
  assert.ok(!graph.nodes.some((n) => n.id.includes("aws_thing")));
  assert.ok(graph.nodes.some((n) => n.id === "aws_s3_bucket.logs"));
});

test("only explicit depends_on becomes an edge (no expression evaluation)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  const depEdges = graph.edges.filter((e) => e.kind === "depends_on");
  // Exactly the two explicit depends_on relationships — the aws_vpc.this.id
  // expression reference must NOT add an edge.
  assert.equal(depEdges.length, 2);
});

test("output ordering is deterministic (byte-stable)", () => {
  const files = readRepo("hcl-repo");
  assert.equal(
    JSON.stringify(parseHclRepo(files).graph),
    JSON.stringify(parseHclRepo(files).graph),
  );
});

test("a 200-file repo parses in well under 30 seconds", () => {
  const files: HclFile[] = Array.from({ length: 200 }, (_, i) => ({
    path: `r${i}.tf`,
    content: `resource "aws_s3_bucket" "b${i}" {\n  bucket = "b${i}"\n}\n`,
  }));
  const start = process.hrtime.bigint();
  const { graph } = parseHclRepo(files);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(graph.nodes.length, 200);
  assert.ok(ms < 30000, `expected < 30000ms, took ${ms.toFixed(1)}ms`);
});
