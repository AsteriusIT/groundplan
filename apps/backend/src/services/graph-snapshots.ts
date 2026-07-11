import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { graphSnapshots, type GraphSnapshotRow } from "../db/schema.js";
import {
  assertValidGraph,
  computeGraphStats,
  type Graph,
} from "../graph/graph.js";

export type SnapshotSource = "plan" | "hcl";

export type InsertSnapshotInput = {
  repositoryId: string;
  source: SnapshotSource;
  ref: string;
  commitSha: string;
  /** Set for plan snapshots tied to a PR; null/omitted for docs snapshots. */
  prNumber?: number | null;
  graph: Graph;
  /** Extra fields merged into `stats` (e.g. HCL parse `warnings`). */
  extraStats?: Record<string, unknown>;
};

/**
 * Validate a graph against the frozen v1 schema, compute stats, and store it.
 * A malformed graph throws `InvalidGraphError` before any write — so an invalid
 * graph is never persisted (the caller surfaces it as a 500 and logs).
 */
export async function insertGraphSnapshot(
  db: NodePgDatabase,
  input: InsertSnapshotInput,
): Promise<GraphSnapshotRow> {
  assertValidGraph(input.graph);
  const stats = { ...computeGraphStats(input.graph), ...input.extraStats };

  const [row] = await db
    .insert(graphSnapshots)
    .values({
      repositoryId: input.repositoryId,
      source: input.source,
      ref: input.ref,
      commitSha: input.commitSha,
      prNumber: input.prNumber ?? null,
      graph: input.graph,
      stats,
    })
    .returning();

  // `.returning()` on a successful insert always yields the row.
  return row as GraphSnapshotRow;
}
