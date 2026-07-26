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
import { diffPolicyReports, type PolicyDelta } from "../graph/policy/diff.js";
import { evaluatePolicy } from "../graph/policy/engine.js";
import { summarizePolicyReport } from "../graph/policy/summarize.js";
import { applyWaivers } from "../graph/policy/waivers.js";
import { listWaivers } from "./policy-waivers.js";
import type {
  PolicyConfig,
  PolicyReport,
  PolicyTarget,
} from "../graph/policy/types.js";
import {
  DOCS_SOURCES,
  PR_SOURCES,
  type SnapshotSource,
} from "./graph-snapshots.js";
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
  /**
   * The instant expiry is judged against (GP-204). Passed in rather than read
   * inside the engine so evaluation stays a pure function of its inputs;
   * defaults to now, which is what every caller but a test wants.
   */
  now?: Date;
};

/**
 * Is this snapshot a review of a change, rather than documentation of a branch?
 * A pull-request snapshot is the one that gets compared with main (GP-202).
 */
function isPullRequestSnapshot(snapshot: GraphSnapshotRow): boolean {
  return PR_SOURCES.includes(snapshot.source);
}

/**
 * Evaluate a snapshot and store the verdict beside it, replacing any previous
 * verdict for that snapshot. Returns the stored row.
 *
 * A pull-request snapshot is also compared with the documentation of main as it
 * stands now, and the comparison is stored with it — so the comment posted to
 * the provider and the panel in the review view say the same thing even after
 * main has moved on.
 */
export async function evaluateSnapshotPolicy(
  db: NodePgDatabase,
  snapshot: GraphSnapshotRow,
  options: EvaluateSnapshotOptions = {},
): Promise<PolicyReportRow> {
  const evaluated = evaluatePolicy(snapshot.graph, {
    target: targetForSource(snapshot.source),
    ...(options.config ? { config: options.config } : {}),
  });

  // GP-204: waivers mark, they do not hide. Applied after evaluation so the
  // violation is still found, still listed and still counted — just answered.
  const waivers = snapshot.repositoryId
    ? await listWaivers(db, snapshot.repositoryId)
    : [];
  const report = applyWaivers(evaluated, waivers, options.now ?? new Date());
  const summaryMd = summarizePolicyReport(report);

  let delta: PolicyDelta | null = null;
  if (isPullRequestSnapshot(snapshot) && snapshot.repositoryId) {
    delta = diffPolicyReports(report, await baselineFor(db, snapshot.repositoryId));
  }

  const [row] = await db
    .insert(policyReports)
    .values({
      snapshotId: snapshot.id,
      repositoryId: snapshot.repositoryId,
      report,
      delta,
      summaryMd,
    })
    .onConflictDoUpdate({
      target: policyReports.snapshotId,
      set: { report, delta, summaryMd, updatedAt: new Date() },
    })
    .returning();

  return row as PolicyReportRow;
}

/**
 * The report of the repository's current documentation of main, or null when
 * there is none to compare against. A repository whose main has never been
 * documented — its very first pull request, a chart we cannot read — compares
 * against nothing, and the delta records that rather than pretending to a clean
 * baseline (the same posture `changesFromBase` takes, GP-103).
 */
async function baselineFor(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<{ report: PolicyReport; snapshotId: string } | null> {
  const docs = await latestDocsSnapshot(db, repositoryId);
  if (!docs) return null;
  const stored = await getPolicyReport(db, docs.id);
  if (!stored) return null;
  return { report: stored.report, snapshotId: docs.id };
}

/**
 * The verdict for a snapshot, computing and storing it if it was never judged.
 * Old snapshots predate the engine, and a reader who opens one should get an
 * answer rather than an absence — the evaluation is deterministic, so producing
 * it now yields exactly what producing it then would have.
 */
export async function ensurePolicyReport(
  db: NodePgDatabase,
  snapshot: GraphSnapshotRow,
): Promise<PolicyReportRow> {
  const existing = await getPolicyReport(db, snapshot.id);
  if (existing) return existing;
  const config = snapshot.repositoryId
    ? await resolvePolicyConfig(db, snapshot.repositoryId)
    : {};
  return evaluateSnapshotPolicy(db, snapshot, { config });
}

/**
 * Judge a freshly-stored snapshot under its repository's configuration. The one
 * call every producer makes; it swallows nothing, so a caller that must not fail
 * (the CI webhook) runs it in the background.
 */
export async function evaluateRepositorySnapshot(
  db: NodePgDatabase,
  snapshot: GraphSnapshotRow,
): Promise<PolicyReportRow | null> {
  if (!snapshot.repositoryId) return null;
  const config = await resolvePolicyConfig(db, snapshot.repositoryId);
  return evaluateSnapshotPolicy(db, snapshot, { config });
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
