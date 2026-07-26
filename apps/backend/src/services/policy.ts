/**
 * GP-200: running the policy engine against a stored snapshot, and keeping the
 * verdict beside it.
 *
 * The engine itself is pure (`graph/policy`). This module is the only thing that
 * knows a report has a home: which snapshots it makes sense to judge, which kind
 * of graph a snapshot holds, and how a re-evaluation replaces a verdict instead
 * of accumulating verdicts.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq, inArray } from "drizzle-orm";

import {
  graphSnapshots,
  policyReports,
  projects,
  repositories,
  type GraphSnapshotRow,
  type PolicyReportRow,
} from "../db/schema.js";
import { evaluatePolicy } from "../graph/policy/engine.js";
import { summarizePolicyReport } from "../graph/policy/summarize.js";
import type { PolicyConfig, PolicyTarget } from "../graph/policy/types.js";
import { DOCS_SOURCES, type SnapshotSource } from "./graph-snapshots.js";
import { resolvePolicyConfig } from "./policy-config.js";

/**
 * Which kind of graph a snapshot holds. Stated once here rather than re-derived
 * at each call site, exactly as `docsSourceFor` states the producer mapping.
 */
export function targetForSource(source: SnapshotSource): PolicyTarget {
  return source.startsWith("k8s_") ? "kubernetes" : "terraform";
}

export type EvaluateSnapshotOptions = {
  /** The resolved configuration; the catalogue's defaults when omitted. */
  config?: PolicyConfig;
};

/**
 * Evaluate a snapshot and store the verdict beside it, replacing any previous
 * verdict for that snapshot. Returns the stored row.
 */
export async function evaluateSnapshotPolicy(
  db: NodePgDatabase,
  snapshot: GraphSnapshotRow,
  options: EvaluateSnapshotOptions = {},
): Promise<PolicyReportRow> {
  const report = evaluatePolicy(snapshot.graph, {
    target: targetForSource(snapshot.source),
    ...(options.config ? { config: options.config } : {}),
  });
  const summaryMd = summarizePolicyReport(report);

  const [row] = await db
    .insert(policyReports)
    .values({
      snapshotId: snapshot.id,
      repositoryId: snapshot.repositoryId,
      report,
      summaryMd,
    })
    .onConflictDoUpdate({
      target: policyReports.snapshotId,
      set: { report, summaryMd, updatedAt: new Date() },
    })
    .returning();

  return row as PolicyReportRow;
}

/** The stored verdict for a snapshot, or null when it was never evaluated. */
export async function getPolicyReport(
  db: NodePgDatabase,
  snapshotId: string,
): Promise<PolicyReportRow | null> {
  const [row] = await db
    .select()
    .from(policyReports)
    .where(eq(policyReports.snapshotId, snapshotId));
  return row ?? null;
}

/** The stored verdicts for several snapshots, keyed by snapshot id. */
export async function getPolicyReports(
  db: NodePgDatabase,
  snapshotIds: string[],
): Promise<Map<string, PolicyReportRow>> {
  if (snapshotIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(policyReports)
    .where(inArray(policyReports.snapshotId, snapshotIds));
  return new Map(rows.map((row) => [row.snapshotId, row]));
}

/** Load a snapshot by id — the one read `evaluateSnapshotPolicy` needs. */
export async function loadSnapshot(
  db: NodePgDatabase,
  id: string,
): Promise<GraphSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(graphSnapshots)
    .where(eq(graphSnapshots.id, id));
  return row ?? null;
}

/**
 * The newest snapshot documenting a repository's default branch — the one a
 * compliance state is *about*, whichever producer wrote it (GP-102).
 */
export async function latestDocsSnapshot(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<GraphSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, repositoryId),
        inArray(graphSnapshots.source, DOCS_SOURCES),
      ),
    )
    .orderBy(desc(graphSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Re-judge the documentation of main for the given repositories under the
 * configuration as it stands now (GP-201).
 *
 * Only the *current* documentation is re-evaluated. A historical report is not
 * refreshed: it recorded what the estate looked like under the configuration
 * that judged it, which is the whole reason the configuration travels inside it
 * — rewriting it would make the timeline lie about the past.
 */
export async function reevaluateDocsPolicy(
  db: NodePgDatabase,
  repositoryIds: string[],
): Promise<void> {
  for (const repositoryId of repositoryIds) {
    const snapshot = await latestDocsSnapshot(db, repositoryId);
    if (!snapshot) continue;
    const config = await resolvePolicyConfig(db, repositoryId);
    await evaluateSnapshotPolicy(db, snapshot, { config });
  }
}

/** Every repository of an organization — the blast radius of an org-level change. */
export async function organizationRepositoryIds(
  db: NodePgDatabase,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .innerJoin(projects, eq(repositories.projectId, projects.id))
    .where(eq(projects.organizationId, organizationId));
  return rows.map((row) => row.id);
}
