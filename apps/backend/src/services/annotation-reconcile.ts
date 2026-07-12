import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import { annotations, type AnnotationRow } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";

/** An annotation reduced to what reconciliation needs. */
export type ReconcilableAnnotation = { id: string; anchors: string[] };

export type ReconcileResult = {
  id: string;
  status: "resolved" | "orphaned";
  /** Anchors whose Terraform address no longer exists as a node. */
  missingAnchors: string[];
};

/**
 * The reconciliation contract (ADR #4 / GP-57): given the annotations and a
 * snapshot's graph, decide each annotation's status. An anchor resolves iff the
 * exact Terraform address exists as a node id. All anchors resolved → `resolved`;
 * any missing → `orphaned`, recording precisely which anchors are gone.
 *
 * Pure and deterministic: no rename heuristics (a renamed resource orphans its
 * annotations — re-anchoring is manual, GP-59), and orphans are never deleted.
 */
export function reconcileAnnotations(
  items: ReconcilableAnnotation[],
  graph: Graph,
): ReconcileResult[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  return items.map((item) => {
    const missingAnchors = item.anchors.filter((a) => !nodeIds.has(a));
    return {
      id: item.id,
      status: missingAnchors.length === 0 ? "resolved" : "orphaned",
      missingAnchors,
    };
  });
}

/**
 * Reconcile a repository's annotations against a freshly generated snapshot's
 * graph and persist the results. Runs synchronously as a post-step of docs
 * snapshot generation (all three paths funnel through `generateDocsSnapshot`).
 * Only rows whose status or missing-anchor set actually changed are written.
 * Returns the number of annotations updated.
 */
export async function reconcileRepositoryAnnotations(
  db: NodePgDatabase,
  repositoryId: string,
  graph: Graph,
): Promise<number> {
  const rows: AnnotationRow[] = await db
    .select()
    .from(annotations)
    .where(eq(annotations.repositoryId, repositoryId));

  const results = reconcileAnnotations(rows, graph);
  const byId = new Map(rows.map((r) => [r.id, r]));

  let updated = 0;
  for (const result of results) {
    const row = byId.get(result.id);
    if (!row) continue;
    const missing = row.missingAnchors ?? [];
    const unchanged =
      row.status === result.status &&
      missing.length === result.missingAnchors.length &&
      missing.every((a, i) => a === result.missingAnchors[i]);
    if (unchanged) continue;

    await db
      .update(annotations)
      .set({ status: result.status, missingAnchors: result.missingAnchors })
      .where(eq(annotations.id, result.id));
    updated += 1;
  }
  return updated;
}
