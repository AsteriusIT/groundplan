import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import { annotations, type AnnotationRow } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";

/** An annotation reduced to what reconciliation needs. */
export type ReconcilableAnnotation = {
  id: string;
  anchors: string[];
  /** Absent is treated as a plain address-anchored annotation. */
  type?: "note" | "link" | "group" | "hide" | "rename";
  /** Absent is treated as `resolved`. Proposals are left alone entirely. */
  status?: "resolved" | "orphaned" | "proposed";
};

export type ReconcileResult = {
  id: string;
  status: "resolved" | "orphaned";
  /** Anchors whose Terraform address (or group) no longer resolves. */
  missingAnchors: string[];
};

/** Does this anchor name a group annotation rather than a Terraform address? */
const isGroupAnchor = (anchor: string, groupIds: ReadonlySet<string>) =>
  groupIds.has(anchor);

/**
 * The reconciliation contract (ADR #4 / GP-57, extended GP-71): given the
 * annotations and a snapshot's graph, decide each annotation's status.
 *
 * An anchor resolves iff the exact Terraform address exists as a node id. All
 * anchors resolved → `resolved` (the epic's *accepted*); any missing →
 * `orphaned`, recording precisely which anchors are gone.
 *
 * Two rules beyond plain address lookup:
 *   - A `link` (logical edge) may anchor to a **group** instead of an address.
 *     Such an anchor resolves iff that group exists and is itself resolved — so
 *     a group whose members all vanished takes its edges down with it, rather
 *     than leaving an edge attached to a container that is no longer drawn.
 *   - A `proposed` annotation (GP-75) is **not reconciled at all** — it is
 *     omitted from the results. Reconciliation must never be the thing that
 *     turns an AI proposal into a live annotation; only a human PATCH does that.
 *
 * Pure and deterministic: no rename heuristics (a renamed resource orphans its
 * annotations — re-anchoring is manual, GP-59), and orphans are never deleted.
 */
export function reconcileAnnotations(
  items: ReconcilableAnnotation[],
  graph: Graph,
): ReconcileResult[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const live = items.filter((item) => item.status !== "proposed");
  const groupIds = new Set(
    live.filter((item) => item.type === "group").map((item) => item.id),
  );

  // Pass 1: everything anchored to plain addresses — which is every group, so
  // pass 2 can ask whether the group an edge points at survived.
  const addressResolved = new Map<string, boolean>();
  const results: ReconcileResult[] = [];
  for (const item of live) {
    if (item.type === "link") continue; // needs the group verdicts; pass 2
    const missingAnchors = item.anchors.filter((a) => !nodeIds.has(a));
    addressResolved.set(item.id, missingAnchors.length === 0);
    results.push({
      id: item.id,
      status: missingAnchors.length === 0 ? "resolved" : "orphaned",
      missingAnchors,
    });
  }

  // Pass 2: logical edges, whose anchors may be addresses or groups.
  for (const item of live) {
    if (item.type !== "link") continue;
    const missingAnchors = item.anchors.filter((anchor) =>
      isGroupAnchor(anchor, groupIds)
        ? addressResolved.get(anchor) !== true
        : !nodeIds.has(anchor),
    );
    results.push({
      id: item.id,
      status: missingAnchors.length === 0 ? "resolved" : "orphaned",
      missingAnchors,
    });
  }

  // Preserve input order, so the output is a pure function of the input and not
  // of the two-pass walk above.
  const byId = new Map(results.map((r) => [r.id, r]));
  return live.map((item) => byId.get(item.id)!);
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
