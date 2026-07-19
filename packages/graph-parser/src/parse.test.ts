import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { HclFile } from "./hcl-parser.js";
import { parse } from "./parse.js";

const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

/** Recursively read a fixture repo directory into HclFile[] (posix paths). */
function readRepo(name: string): HclFile[] {
  const root = join(fixturesDir, name);
  const files: HclFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else files.push({ path: rel, content: readFileSync(abs, "utf8") });
    }
  };
  walk(root, "");
  return files;
}

function readGolden(name: string): unknown {
  return JSON.parse(
    readFileSync(join(fixturesDir, "graphs", `${name}.graph.json`), "utf8"),
  );
}

test("parse returns the same snapshot parseHclRepo produced (golden)", () => {
  const { snapshot } = parse(readRepo("hcl-repo"));
  assert.deepEqual(snapshot, readGolden("hcl-repo"));
});

test("a skipped file becomes an error diagnostic carrying the file path", () => {
  const { diagnostics } = parse(readRepo("hcl-repo"));
  const errors = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.file, "broken.tf");
  assert.match(errors[0]?.message ?? "", /unbalanced braces/);
});

test("an unresolved reference becomes a warning anchored to the from-node's source", () => {
  const files: HclFile[] = [
    {
      path: "main.tf",
      content: [
        // The referenced *type* is declared (so the parser treats the
        // expression as a reference), but the *name* is not.
        `resource "azurerm_subnet" "real" {`,
        `}`,
        ``,
        `resource "azurerm_linux_virtual_machine" "vm" {`,
        `  subnet_id = azurerm_subnet.missing.id`,
        `}`,
      ].join("\n"),
    },
  ];
  const { diagnostics } = parse(files);
  const warning = diagnostics.find((d) =>
    d.message.includes("azurerm_subnet.missing"),
  );
  assert.ok(warning, "expected an unresolved-reference warning");
  assert.equal(warning.severity, "warning");
  assert.equal(warning.file, "main.tf");
  assert.deepEqual(warning.range, { start_line: 4, end_line: 6 });
});

test("an empty repository is empty, not an error", () => {
  const { snapshot, diagnostics } = parse([]);
  assert.equal(snapshot.nodes.length, 0);
  assert.deepEqual(diagnostics, []);
});

test("a configured root holding no .tf warns, with no file to point at", () => {
  const { diagnostics } = parse(readRepo("hcl-repo"), {
    rootDir: "modules/missing",
  });
  const warning = diagnostics.find((d) => /no \.tf files found/.test(d.message));
  assert.ok(warning, "expected a no-tf-files warning");
  assert.equal(warning.severity, "warning");
  assert.equal(warning.file, undefined);
});

test("rootDir is honoured, matching terraform -chdir semantics", () => {
  const files = readRepo("hcl-repo");
  const scoped = parse(files, { rootDir: "modules/network" });
  assert.ok(scoped.snapshot.nodes.length > 0);
  assert.ok(
    scoped.snapshot.nodes.every((n) => n.source?.file.startsWith("modules/")),
  );
});
