/**
 * What the Diff button prints, derived from the differ-annotated graph.
 *
 * There is no counting logic here on purpose. `computeGraphStats` is the fold
 * the backend stores beside every snapshot and the PR comment counts with; run
 * over the same graph the canvas draws, it *is* the panel's summary. A second
 * implementation would be a second opinion, and two places that both claim to
 * say how many resources changed will eventually disagree.
 */
import { computeGraphStats, type Graph } from "@groundplan/graph-parser";

export type DiffCounts = {
  created: number;
  updated: number;
  deleted: number;
  /** Unchanged nodes that depend on a changed one — never part of `total`. */
  impacted: number;
  /** created + updated + deleted: "is there anything to look at". */
  total: number;
};

export function diffCounts(graph: Graph): DiffCounts {
  const { changes, impactedCount } = computeGraphStats(graph);
  return {
    created: changes.create,
    updated: changes.update,
    deleted: changes.delete,
    impacted: impactedCount,
    total: changes.create + changes.update + changes.delete,
  };
}
