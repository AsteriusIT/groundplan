/**
 * GP-208: storing what actually exists — Producer D's landing place.
 *
 * The parsing lives in the CLI, on the user's machine, and that is the whole
 * design: a state file holds every password Terraform ever generated, so it is
 * read where it already sits and only the derived graph travels. This module
 * receives that graph, refuses anything that smells like a raw state, and keeps
 * exactly one reality snapshot per repository.
 *
 * One, not a history. A drift measurement is an event worth keeping — it says
 * "on this date, against this commit, these things had moved". A reality
 * snapshot is a *position*: the estate as it stood when somebody last looked,
 * and the previous position is not something anybody asks to see. Keeping a
 * timeline of them would grow without bound and answer no question.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";

import { graphSnapshots, type GraphSnapshotRow } from "../db/schema.js";
import { assertValidGraph, type Graph } from "../graph/graph.js";
import { REALITY_SOURCE, insertGraphSnapshot } from "./graph-snapshots.js";

/** Thrown when a payload is a raw state file rather than a derived graph. */
export class RawStateRejectedError extends Error {
  constructor() {
    super(
      "that looks like a raw Terraform state file. Groundplan never accepts one: a state holds every secret your configuration touched, so it is parsed and sanitised on your machine and only the derived graph is sent. Use `npx @asteriusit/cli push-state --file terraform.tfstate` (add --dry-run to read exactly what it would send).",
    );
    this.name = "RawStateRejectedError";
  }
}

/**
 * Does this payload look like a raw `terraform.tfstate`?
 *
 * The check is the promise made checkable. It mirrors the CLI's own
 * `isRawState`: a graph snapshot has `version` too, so the discriminator is the
 * fields only a state carries — its identity (`lineage`/`serial`), the version
 * of the tool that wrote it, or the pre-0.12 `modules` shape — alongside a
 * `resources` array, which a graph never has.
 */
export function looksLikeRawState(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (!Array.isArray(value["resources"])) return false;
  return (
    "lineage" in value ||
    "serial" in value ||
    "terraform_version" in value ||
    "modules" in value
  );
}

export type RecordRealityInput = {
  repositoryId: string;
  /** The branch the estate is supposed to build. */
  ref: string;
  /** The sha of that branch when the state was read. */
  commitSha: string;
  /** The graph the CLI derived. Validated against the schema before storage. */
  graph: unknown;
  /** Which Terraform wrote the state, when the CLI could tell. */
  terraformVersion?: string | null;
};

/**
 * Store a reality snapshot, replacing the repository's previous one.
 *
 * Throws `RawStateRejectedError` for a raw state and `InvalidGraphError` for a
 * body that is not a graph — both before any write, so a bad push stores
 * nothing rather than half a picture of somebody's estate.
 */
export async function recordReality(
  db: NodePgDatabase,
  input: RecordRealityInput,
): Promise<GraphSnapshotRow> {
  if (looksLikeRawState(input.graph)) throw new RawStateRejectedError();
  assertValidGraph(input.graph);
  const graph: Graph = input.graph;

  await db
    .delete(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, input.repositoryId),
        eq(graphSnapshots.source, REALITY_SOURCE),
      ),
    );

  return insertGraphSnapshot(db, {
    repositoryId: input.repositoryId,
    source: REALITY_SOURCE,
    ref: input.ref,
    commitSha: input.commitSha,
    graph,
    extraStats: {
      ...(input.terraformVersion
        ? { terraformVersion: input.terraformVersion }
        : {}),
    },
  });
}

/** The repository's reality snapshot, or null when nobody has pushed one. */
export async function latestRealitySnapshot(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<GraphSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, repositoryId),
        eq(graphSnapshots.source, REALITY_SOURCE),
      ),
    )
    .orderBy(desc(graphSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}
