/**
 * Client-side fuzzy search over graph nodes (GP-25). The whole graph is already
 * loaded, so this is a simple in-memory subsequence match over a node's name,
 * type and address — enough for "vnet" to find `azurerm_virtual_network`.
 */
import type { GraphNode } from "@/api/types";

/** True when every char of `query` appears in `text`, in order (case-insensitive). */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

/** A small score so more literal matches rank above looser subsequence hits. */
function score(query: string, node: GraphNode): number {
  const q = query.toLowerCase();
  const name = node.name.toLowerCase();
  const type = node.type.toLowerCase();
  const id = node.id.toLowerCase();
  if (name.startsWith(q) || type.startsWith(q)) return 0;
  if (name.includes(q) || type.includes(q) || id.includes(q)) return 1;
  return 2; // subsequence-only
}

/**
 * Up to `limit` resource nodes matching `query`, best matches first. Module
 * (container) nodes are excluded — you search for resources.
 */
export function searchNodes(
  nodes: readonly GraphNode[],
  query: string,
  limit = 10,
): GraphNode[] {
  const q = query.trim();
  if (!q) return [];
  return nodes
    .filter((n) => n.type !== "module")
    // The id is the address (type + "." + name), so it already carries the type.
    .map((n) => ({ n, haystack: `${n.name} ${n.id}` }))
    .filter((x) => fuzzyMatch(q, x.haystack))
    .sort((a, b) => score(q, a.n) - score(q, b.n) || a.n.id.localeCompare(b.n.id))
    .slice(0, limit)
    .map((x) => x.n);
}
