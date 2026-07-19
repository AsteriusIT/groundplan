/**
 * Diff-mode visual hierarchy (GP-155): derive a per-node emphasis tier from
 * the change data a snapshot already carries, so changed and impacted
 * resources dominate and the unchanged estate recedes. Pure presentation —
 * no schema change, no layout change; the node/edge components render the
 * tier as CSS.
 *
 * Tiers: `changed` (create/update/delete) and `impacted` keep full contrast
 * (the existing v3 styles); `context` (one hop from either) dims slightly so
 * the blast radius keeps its surroundings; `ghost` (everything else) recedes.
 */
import type { Graph, GraphEdge } from "../types";

export type Emphasis = "changed" | "impacted" | "context" | "ghost";

const isModule = (type: string): boolean => type === "module";

/**
 * The emphasis tier per resource node, or null when the treatment does not
 * apply: not in diff mode, or nothing changed — ghosting an estate with no
 * signal to pop would just dim the whole diagram. Module containers carry no
 * entry (structure never ghosts). Deterministic: same snapshot, same map.
 */
export function emphasisMap(
  graph: Graph,
  active: boolean,
): Map<string, Emphasis> | null {
  if (!active) return null;

  // The signal set: what this diff is about.
  const signal = new Set<string>();
  for (const node of graph.nodes) {
    if (isModule(node.type)) continue;
    if ((node.change !== null && node.change !== "noop") || node.impacted === true) {
      signal.add(node.id);
    }
  }
  if (signal.size === 0) return null;

  // One hop of context around the signal, over every edge kind.
  const context = new Set<string>();
  for (const edge of graph.edges) {
    if (signal.has(edge.from)) context.add(edge.to);
    if (signal.has(edge.to)) context.add(edge.from);
  }

  const map = new Map<string, Emphasis>();
  for (const node of graph.nodes) {
    if (isModule(node.type)) continue;
    if (node.change !== null && node.change !== "noop") map.set(node.id, "changed");
    else if (node.impacted === true) map.set(node.id, "impacted");
    else if (context.has(node.id)) map.set(node.id, "context");
    else map.set(node.id, "ghost");
  }
  return map;
}

/**
 * Should this edge recede? Full contrast only while at least one endpoint is
 * changed or impacted — an edge between two bystanders is background.
 */
export function edgeGhosted(
  edge: GraphEdge,
  map: ReadonlyMap<string, Emphasis> | null,
): boolean {
  if (!map) return false;
  const lit = (tier: Emphasis | undefined): boolean =>
    tier === "changed" || tier === "impacted";
  return !lit(map.get(edge.from)) && !lit(map.get(edge.to));
}
