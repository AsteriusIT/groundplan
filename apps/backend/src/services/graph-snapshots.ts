import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { graphSnapshots, type GraphSnapshotRow } from "../db/schema.js";
import {
  assertValidGraph,
  computeGraphStats,
  type Graph,
} from "../graph/graph.js";
import { summarize } from "../graph/summarize.js";

export type SnapshotSource =
  | "plan"
  | "hcl"
  | "k8s_namespace"
  | "k8s_manifest"
  | "k8s_rendered";

/** What a repository holds (GP-101) — the axis every producer choice turns on. */
export type IacType = "terraform" | "kubernetes";

/**
 * The two questions every consumer of snapshots actually asks — "what documents
 * this repository's main branch?" and "what does a pull request in it look like?"
 * — answered in one place, so the mapping from a repository's kind to its producer
 * is stated once rather than re-derived at each `where` clause.
 */
export function docsSourceFor(iacType: IacType): SnapshotSource {
  return iacType === "kubernetes" ? "k8s_manifest" : "hcl";
}

export function prSourceFor(iacType: IacType): SnapshotSource {
  return iacType === "kubernetes" ? "k8s_rendered" : "plan";
}

/** Every source that documents a default branch — what the docs list is made of. */
export const DOCS_SOURCES: SnapshotSource[] = ["hcl", "k8s_manifest"];

/** Every source that describes a pull request's head. */
export const PR_SOURCES: SnapshotSource[] = ["plan", "k8s_rendered"];

/** What the snapshot is *of*: a repository's Terraform, or a cluster's namespace. */
type SnapshotOwner =
  | { repositoryId: string; clusterId?: never; namespace?: never }
  | { clusterId: string; namespace: string; repositoryId?: never };

export type InsertSnapshotInput = SnapshotOwner & {
  source: SnapshotSource;
  ref: string;
  commitSha: string;
  /** Set for plan snapshots tied to a PR; null/omitted for docs snapshots. */
  prNumber?: number | null;
  graph: Graph;
  /** Extra fields merged into `stats` (e.g. HCL parse / RBAC `warnings`). */
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
  const summaryMd = summarize(input.graph);

  const [row] = await db
    .insert(graphSnapshots)
    .values({
      // Exactly one owner, which the table's check constraint also insists on.
      repositoryId: input.repositoryId ?? null,
      clusterId: input.clusterId ?? null,
      namespace: input.namespace ?? null,
      source: input.source,
      ref: input.ref,
      commitSha: input.commitSha,
      prNumber: input.prNumber ?? null,
      graph: input.graph,
      stats,
      summaryMd,
    })
    .returning();

  // `.returning()` on a successful insert always yields the row.
  return row as GraphSnapshotRow;
}
