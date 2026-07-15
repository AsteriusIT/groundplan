/**
 * GP-36: a rule-based, human-readable Markdown summary of a plan snapshot.
 *
 * Pure function — graph in, Markdown out; no I/O, no adjectives, no speculation.
 * Every line is derivable from the graph, so the output is byte-stable and can
 * be golden-tested. This is the deterministic benchmark the PR comment (GP-38)
 * renders and the fallback the future AI summary is measured against.
 *
 * Section order is fixed and intentional: **deletions first** (the riskiest),
 * then updates, then creations grouped by category, then the impacted blast
 * radius. Every section is capped; overflow collapses to "…and n more".
 */
import { categorize, CATEGORY_LABEL, shortType, type Category } from "./categories.js";
import type { Graph, GraphNode } from "./graph.js";

/** Most rows shown per section before the "…and n more" overflow line. */
const SECTION_CAP = 10;
/** Impacted is deliberately tighter — "top 5 by lowest impact_distance". */
const IMPACTED_CAP = 5;
/** Changed-attribute keys shown per updated node before the trailing "…". */
const KEYS_SHOWN = 3;

const byId = (a: { id: string }, b: { id: string }): number => {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
};

const isResource = (n: GraphNode): boolean => n.type !== "module";

/** Append a capped list of items plus an "…and n more" line when it overflows. */
function capped(items: string[], cap: number): string[] {
  if (items.length <= cap) return items;
  const shown = items.slice(0, cap);
  shown.push(`…and ${items.length - cap} more`);
  return shown;
}

/** `- \`address\`` list lines for the deleted nodes (address only). */
function deletedLines(nodes: GraphNode[]): string[] {
  const deleted = nodes.filter((n) => n.change === "delete").sort(byId);
  return capped(
    deleted.map((n) => `- \`${n.id}\``),
    SECTION_CAP,
  );
}

/** `- \`address\` — key, key, …` list lines for the updated nodes. */
function updatedLines(nodes: GraphNode[]): string[] {
  const updated = nodes.filter((n) => n.change === "update").sort(byId);
  return capped(
    updated.map((n) => {
      const keys = (n.attribute_diff ?? []).map((row) => row.key);
      if (keys.length === 0) return `- \`${n.id}\``;
      const shown = keys.slice(0, KEYS_SHOWN);
      if (keys.length > KEYS_SHOWN) shown.push("…");
      return `- \`${n.id}\` — ${shown.join(", ")}`;
    }),
    SECTION_CAP,
  );
}

/** `- Category: n (type ×k, type, …)` list lines for the created nodes. */
function createdLines(nodes: GraphNode[]): string[] {
  const created = nodes.filter((n) => n.change === "create");

  // Bucket by category, and within each category count short resource types.
  const byCategory = new Map<Category, Map<string, number>>();
  for (const node of created) {
    const category = categorize(node.type);
    const types = byCategory.get(category) ?? new Map<string, number>();
    types.set(shortType(node.type), (types.get(shortType(node.type)) ?? 0) + 1);
    byCategory.set(category, types);
  }

  const rows = [...byCategory.entries()].map(([category, types]) => {
    const total = [...types.values()].reduce((sum, k) => sum + k, 0);
    // Types: most numerous first, ties broken alphabetically. `×k` only when >1.
    const parts = [...types.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([type, k]) => (k > 1 ? `${type} ×${k}` : type));
    return {
      total,
      label: CATEGORY_LABEL[category],
      line: `- ${CATEGORY_LABEL[category]}: ${total} (${parts.join(", ")})`,
    };
  });

  // Biggest category first, ties broken by label.
  rows.sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : 1));
  return capped(
    rows.map((r) => r.line),
    SECTION_CAP,
  );
}

/** `- \`address\` (n hops)` list lines for the impacted (blast-radius) nodes. */
function impactedLines(nodes: GraphNode[]): string[] {
  const impacted = nodes
    .filter((n) => n.impacted === true)
    .sort(
      (a, b) =>
        (a.impact_distance ?? Infinity) - (b.impact_distance ?? Infinity) ||
        byId(a, b),
    );
  return capped(
    impacted.map((n) => {
      const d = n.impact_distance ?? 0;
      return `- \`${n.id}\` (${d} hop${d === 1 ? "" : "s"})`;
    }),
    IMPACTED_CAP,
  );
}

/** The bold headline: only non-zero segments, always in a fixed order. */
function headline(nodes: GraphNode[]): string {
  const counts = { create: 0, update: 0, delete: 0 };
  let impacted = 0;
  let resources = 0;
  for (const n of nodes) {
    if (!isResource(n)) continue;
    resources += 1;
    if (n.change === "create") counts.create += 1;
    else if (n.change === "update") counts.update += 1;
    else if (n.change === "delete") counts.delete += 1;
    if (n.impacted === true) impacted += 1;
  }

  const segments: string[] = [];
  if (counts.create > 0) segments.push(`+${counts.create} created`);
  if (counts.update > 0) segments.push(`~${counts.update} updated`);
  if (counts.delete > 0) segments.push(`−${counts.delete} deleted`);
  if (impacted > 0) segments.push(`${impacted} impacted`);

  const noun = resources === 1 ? "resource" : "resources";
  return `**${segments.join(" · ")}** (${resources} ${noun})`;
}

/**
 * Render a plan graph to a deterministic Markdown summary. A graph with no
 * create/update/delete (a docs snapshot, or a no-op plan) collapses to a single
 * "No changes." line. Empty sections are omitted entirely.
 */
export function summarize(graph: Graph): string {
  const nodes = graph.nodes;
  const changed = nodes.some(
    (n) => n.change === "create" || n.change === "update" || n.change === "delete",
  );
  if (!changed) return "No changes.";

  const sections: string[][] = [
    [headline(nodes)],
    section("Deleted", deletedLines(nodes)),
    section("Updated", updatedLines(nodes)),
    section("Created", createdLines(nodes)),
    section("Impacted", impactedLines(nodes)),
  ];

  return sections
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

/** A titled section, or [] (omitted) when it has no rows. */
function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return [`**${title}**`, ...lines];
}
