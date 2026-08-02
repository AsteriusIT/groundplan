/**
 * BuilderGraph → Terraform (GP-134). Deterministic, template-free, no AI: the
 * same graph produces byte-identical files, every time, on every machine
 * (ADR #3). The templates *are* the catalog entries — this file knows how to
 * render an attribute, a reference and a block, and nothing about azurerm.
 *
 * The output is a scaffold: literal values, no variables, no `count`, no
 * modules. Once written it is ordinary Terraform, and the only truth there is
 * about the infrastructure it describes (ADR #5).
 */
import type { BuilderGraph, BuilderNode, BuilderValue } from "./builder-graph.js";
import { addressOf } from "./builder-graph.js";
import {
  CATALOG,
  defFor,
  type AttributeDef,
  type ReferenceSlot,
  type ResourceCategory,
  type ResourceDef,
} from "./catalog.js";
import { attributeValue, isBlank } from "./validate.js";

export type GeneratedFile = { path: string; content: string };

/** Which file each category is generated into. */
export const FILE_OF_CATEGORY: Record<ResourceCategory, string> = {
  foundation: "main.tf",
  network: "network.tf",
  compute: "compute.tf",
  data: "data.tf",
};

/** Where resources the catalog does not describe are written. */
export const CUSTOM_FILE = "custom.tf";

/** Every file the builder can write — what the collision check compares against. */
export const GENERATED_FILES: readonly string[] = [
  ...new Set([...Object.values(FILE_OF_CATEGORY), CUSTOM_FILE]),
];

/**
 * Which providers a composition needs, and where each comes from. Derived from
 * the type prefixes on the canvas (GP-238) rather than assumed: the builder is
 * no longer Azure-only, and a preamble that named `azurerm` for a graph of
 * Kubernetes objects would be a file that does not plan.
 *
 * `hashicorp` is the namespace for anything not listed, which is right for
 * every provider the catalog allowlists and wrong for nothing it can compose.
 */
const PROVIDER_NAMESPACES: Record<string, string> = {
  azurerm: "hashicorp",
  aws: "hashicorp",
  google: "hashicorp",
  kubernetes: "hashicorp",
  random: "hashicorp",
  null: "hashicorp",
};

/**
 * The major to pin when no catalog version is known — the one the curated
 * entries were written against. Anything not listed gets no `version` at all,
 * which is the honest constraint: we did not read a version, so we do not
 * pretend to have picked one.
 */
const CURATED_MAJOR: Record<string, string> = { azurerm: "4" };

/** The provider a type belongs to: `azurerm_subnet` → `azurerm`. */
function providerOf(type: string): string {
  const at = type.indexOf("_");
  return at === -1 ? type : type.slice(0, at);
}

/**
 * `provider "x" {}` blocks the generated files need. `azurerm` is the one that
 * cannot be omitted — its `features` block is mandatory — and the rest are
 * emitted empty, which is the correct declaration when there are no
 * credentials to put in one. There never are: this deployment holds none.
 */
function providerBlock(name: string): string {
  return name === "azurerm"
    ? `provider "azurerm" {\n  features {}\n}`
    : `provider "${name}" {}`;
}

/**
 * The preamble, at the top of `main.tf`. No credentials and no backend: this
 * deployment never holds either, and a generated file that pretended otherwise
 * would be teaching the wrong thing.
 *
 * Versions are pinned to the major the catalog read, as a `~>` constraint — the
 * builder composed against a real schema and the file should say which one.
 */
export function header(
  providers: readonly { name: string; version?: string }[],
): string {
  const required = providers.map(({ name, version }) => {
    const namespace = PROVIDER_NAMESPACES[name] ?? "hashicorp";
    const major = version?.split(".")[0] ?? CURATED_MAJOR[name];
    return [
      `    ${name} = {`,
      `      source  = "${namespace}/${name}"`,
      ...(major ? [`      version = "~> ${major}.0"`] : []),
      "    }",
    ].join("\n");
  });

  return [
    "# Generated from the visual builder. Edit it freely: from here on this file is",
    "# the source of truth, and the sketch it came from is only a sketch.",
    "",
    "terraform {",
    "  required_providers {",
    ...required,
    "  }",
    "}",
    "",
    ...providers.map((provider) => providerBlock(provider.name)),
  ].join("\n");
}

/** One `key = value` line, before alignment. */
type Line = { key: string; value: string };

/** A string as HCL: quoted, with quotes and backslashes escaped. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Which block a node is written as (GP-248). The only difference between the
 * two, on this side: `data` reads what exists, `resource` declares it — and
 * every reference to a lookup is addressed through `data.` (see `addressOf`).
 */
function blockKeyword(node: BuilderNode): string {
  return node.mode === "data" ? "data" : "resource";
}

/** A builder value as the HCL literal it stands for. */
export function renderValue(value: BuilderValue): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `[${value.map(quote).join(", ")}]`;
}

/** `azurerm_virtual_network.this.name` — a reference, never a copied string. */
function renderReference(target: BuilderNode, slot: ReferenceSlot): string {
  return `${addressOf(target)}.${slot.targetAttribute}`;
}

/** Pad every key to the widest, the way `terraform fmt` aligns a block. */
function align(lines: readonly Line[], indent: string): string[] {
  const width = lines.reduce((max, line) => Math.max(max, line.key.length), 0);
  return lines.map(
    (line) => `${indent}${line.key.padEnd(width)} = ${line.value}`,
  );
}

/** A catalog line (`key = value`), split for alignment. Malformed lines pass through. */
function parseLine(text: string): Line | null {
  const at = text.indexOf("=");
  if (at === -1) return null;
  return { key: text.slice(0, at).trim(), value: text.slice(at + 1).trim() };
}

/**
 * Substitute the one templating rule a block line may carry:
 * `${attr:admin_username}` → the node's rendered value for that attribute.
 * An attribute with no value substitutes to nothing, which validation has
 * already reported as missing.
 */
function substitute(text: string, node: BuilderNode, def: ResourceDef): string {
  return text.replace(/\$\{attr:([a-z0-9_]+)\}/gi, (_match, name: string) => {
    const attribute = def.attributes.find((a) => a.name === name);
    if (!attribute) return "";
    const value = attributeValue(attribute, node);
    return value === undefined ? "" : renderValue(value);
  });
}

/** The lines an attribute contributes, or none when it is blank and optional. */
function attributeLine(attribute: AttributeDef, node: BuilderNode): Line | null {
  const value = attributeValue(attribute, node);
  if (value === undefined || isBlank(value)) return null;
  return { key: attribute.name, value: renderValue(value) };
}

/** The line a slot contributes, given what is connected to it. */
function slotLine(
  slot: ReferenceSlot,
  targets: readonly BuilderNode[],
): Line | null {
  if (targets.length === 0) return null;
  const rendered = targets
    .map((target) => renderReference(target, slot))
    // Sorted, so the order connections were drawn in cannot change the file.
    .sort((a, b) => a.localeCompare(b));
  return {
    key: slot.attribute,
    value: slot.list ? `[${rendered.join(", ")}]` : (rendered[0] as string),
  };
}

/** What is connected to each slot of a node, in catalog order. */
function targetsBySlot(
  node: BuilderNode,
  graph: BuilderGraph,
  byId: Map<string, BuilderNode>,
): Map<string, BuilderNode[]> {
  const bySlot = new Map<string, BuilderNode[]>();
  for (const reference of graph.references) {
    if (reference.from !== node.id) continue;
    const target = byId.get(reference.to);
    if (!target) continue;
    bySlot.set(reference.attribute, [
      ...(bySlot.get(reference.attribute) ?? []),
      target,
    ]);
  }
  return bySlot;
}

/** One nested block: its static lines, then the fields and slots it hosts. */
function renderBlock(
  name: string,
  node: BuilderNode,
  def: ResourceDef,
  bySlot: Map<string, BuilderNode[]>,
): string {
  const block = (def.blocks ?? []).find((b) => b.name === name);
  const lines: Line[] = [];
  for (const raw of block?.lines ?? []) {
    const line = parseLine(substitute(raw, node, def));
    if (line) lines.push(line);
  }
  for (const attribute of def.attributes) {
    if (attribute.block !== name) continue;
    const line = attributeLine(attribute, node);
    if (line) lines.push(line);
  }
  for (const slot of def.references) {
    if (slot.block !== name) continue;
    const line = slotLine(slot, bySlot.get(slot.attribute) ?? []);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return `  ${name} {}`;
  return [`  ${name} {`, ...align(lines, "    "), "  }"].join("\n");
}

/**
 * A resource the catalog does not describe: whatever the user typed, in a
 * stable order. Attributes are sorted by key and references by the attribute
 * they fill, so determinism does not depend on the order somebody happened to
 * add the rows in.
 */
function renderCustomResource(
  node: BuilderNode,
  graph: BuilderGraph,
  byId: Map<string, BuilderNode>,
): string {
  const lines: Line[] = Object.entries(node.attributes)
    .filter(([, value]) => !isBlank(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value: renderValue(value) }));

  const references = graph.references
    .filter((reference) => reference.from === node.id)
    .flatMap((reference) => {
      const target = byId.get(reference.to);
      if (!target || !reference.targetAttribute) return [];
      return [
        {
          key: reference.attribute,
          value: `${addressOf(target)}.${reference.targetAttribute}`,
        },
      ];
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return [
    `${blockKeyword(node)} ${quote(node.type)} ${quote(node.name)} {`,
    ...align([...lines, ...references], "  "),
    "}",
  ].join("\n");
}

/** One `resource` block: top-level fields, top-level connections, then blocks. */
export function renderResource(
  node: BuilderNode,
  def: ResourceDef,
  graph: BuilderGraph,
  byId: Map<string, BuilderNode>,
): string {
  const bySlot = targetsBySlot(node, graph, byId);
  const lines: Line[] = [];
  for (const attribute of def.attributes) {
    if (attribute.block) continue;
    const line = attributeLine(attribute, node);
    if (line) lines.push(line);
  }
  for (const slot of def.references) {
    if (slot.block) continue;
    const line = slotLine(slot, bySlot.get(slot.attribute) ?? []);
    if (line) lines.push(line);
  }

  const body = align(lines, "  ");
  const blocks = (def.blocks ?? []).map((block) =>
    renderBlock(block.name, node, def, bySlot),
  );
  return [
    `${blockKeyword(node)} ${quote(node.type)} ${quote(node.name)} {`,
    ...body,
    ...blocks.flatMap((block) => (body.length > 0 ? ["", block] : [block])),
    "}",
  ].join("\n");
}

/** Which file a definition's resources are written into. */
export function fileOf(def: ResourceDef): string {
  if (def.file) return def.file;
  return def.category ? FILE_OF_CATEGORY[def.category] : CUSTOM_FILE;
}

/**
 * Every provider the composition needs, in a stable order, each with the
 * version the catalog read for it. Derived from what is on the canvas — a
 * composition of Kubernetes objects must not declare `azurerm`.
 */
function providersOf(
  graph: BuilderGraph,
  catalog: readonly ResourceDef[],
  versions: Readonly<Record<string, string>>,
): { name: string; version?: string }[] {
  const names = new Set<string>();
  for (const node of graph.nodes) {
    // A custom resource's provider counts too: the user typed a real Terraform
    // type, and the file it lands in needs that provider declared.
    if (!node.custom && !defFor(node, catalog)) continue;
    if (node.type.trim() === "") continue;
    names.add(providerOf(node.type));
  }
  return [...names].sort().map((name) => ({
    name,
    ...(versions[name] ? { version: versions[name] } : {}),
  }));
}

export type GenerateOptions = {
  /** The catalog to render against. Defaults to the curated one. */
  catalog?: readonly ResourceDef[];
  /**
   * Provider name → the version the catalog read, so the generated
   * `required_providers` pins the major that was actually composed against.
   */
  versions?: Readonly<Record<string, string>>;
};

/**
 * The `.tf` files a builder graph becomes. Resources go to their definition's
 * file — the curated category's, or the provider's own for a type derived from
 * a schema — and are sorted by (type, name) inside each one, so neither the
 * order nodes were created in nor where they sit on the canvas can change a
 * byte of the output.
 *
 * Nodes of a type the catalog does not know are skipped — `validateBuilderGraph`
 * has already reported them, and the endpoint refuses the graph before reaching
 * here.
 */
export function generateTerraform(
  graph: BuilderGraph,
  options: readonly ResourceDef[] | GenerateOptions = {},
): GeneratedFile[] {
  // The second argument used to be the catalog itself (GP-134); accepting both
  // keeps every existing caller and test working while the options grow.
  const opts: GenerateOptions = Array.isArray(options)
    ? { catalog: options }
    : (options as GenerateOptions);
  const catalog = opts.catalog ?? CATALOG;
  const versions = opts.versions ?? {};

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const byFile = new Map<string, string[]>();

  // By type, then lookups before declarations of that type, then by name — so
  // neither the order nodes were created in nor where they sit on the canvas
  // can change a byte, and a `data` block reads before what uses it.
  const ordered = [...graph.nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    const mode = (a.mode ?? "resource").localeCompare(b.mode ?? "resource");
    return mode === 0 ? a.name.localeCompare(b.name) : mode;
  });

  for (const node of ordered) {
    if (node.custom) {
      byFile.set(CUSTOM_FILE, [
        ...(byFile.get(CUSTOM_FILE) ?? []),
        renderCustomResource(node, graph, byId),
      ]);
      continue;
    }
    const def = defFor(node, catalog);
    if (!def) continue;
    const path = fileOf(def);
    byFile.set(path, [
      ...(byFile.get(path) ?? []),
      renderResource(node, def, graph, byId),
    ]);
  }

  // The curated files first, in their fixed order, then any provider file a
  // derived type introduced — sorted, so the set of paths is a function of the
  // graph and never of the order the nodes were added in.
  const derived = [...byFile.keys()]
    .filter((path) => !GENERATED_FILES.includes(path))
    .sort((a, b) => a.localeCompare(b));

  const files: GeneratedFile[] = [];
  for (const path of [...GENERATED_FILES, ...derived]) {
    const blocks = byFile.get(path) ?? [];
    const preamble =
      path === "main.tf" ? [header(providersOf(graph, catalog, versions))] : [];
    if (blocks.length === 0 && preamble.length === 0) continue;
    files.push({ path, content: `${[...preamble, ...blocks].join("\n\n")}\n` });
  }
  return files;
}
