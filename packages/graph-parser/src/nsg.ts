/**
 * NSG payload derivation (GP-43): the security-group rules, the computed
 * `internet_exposed` flag, and the subnet/NIC associations. Extraction differs by
 * producer (structured plan `after` vs. HCL text), but the flag, port
 * normalization, and the attach step are shared here so both producers agree.
 */
import type { GraphNode, NsgRule } from "./graph.js";

const INTERNET_SOURCES = new Set(["*", "0.0.0.0/0", "internet"]);

/** The whole heuristic: any inbound Allow from an internet source ⇒ exposed. */
export function computeInternetExposed(rules: readonly NsgRule[]): boolean {
  return rules.some(
    (r) =>
      r.direction.toLowerCase() === "inbound" &&
      r.access.toLowerCase() === "allow" &&
      INTERNET_SOURCES.has(r.source.trim().toLowerCase()),
  );
}

/** Normalize a port range value to `"80"`, `"80-443"`, or `"*"`. Passthrough. */
export function normalizePorts(raw: unknown): string {
  if (raw === undefined || raw === null) return "*";
  const s = String(raw as string | number).trim();
  return s === "" ? "*" : s;
}

/** Per-NSG extracted rules keyed by NSG node id, produced by a parser. The
 * subnet/NIC associations that used to ride here now come from the azurerm join
 * catalog (`azurerm-joins.ts`) and attach via `attachAssociations`. */
export type ExtractedNsg = { rules: NsgRule[] };

/**
 * Attach `associated_ids` to the mapped nodes: every satellite the join catalog
 * classified as an attachment — an NSG or route table on its subnet (GP-43/89),
 * an NSG/ASG on a NIC, private endpoint, or scale set. Deduped + sorted for
 * stable output. Mutates the nodes in place.
 */
export function attachAssociations(
  nodes: GraphNode[],
  associations: ReadonlyMap<string, string[]>,
): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, targets] of associations) {
    const node = byId.get(id);
    if (!node || targets.length === 0) continue;
    node.associated_ids = [...new Set(targets)].sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Attach `rules` and `internet_exposed` to the matching NSG nodes. Rules are
 * sorted by priority (then name) for stable, deterministic output. Mutates the
 * nodes in place.
 */
export function attachNsg(
  nodes: GraphNode[],
  extracted: ReadonlyMap<string, ExtractedNsg>,
): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [nsgId, data] of extracted) {
    const node = byId.get(nsgId);
    if (!node) continue;
    const rules = [...data.rules].sort(
      (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
    );
    node.rules = rules;
    node.internet_exposed = computeInternetExposed(rules);
  }
}
