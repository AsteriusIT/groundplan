/**
 * GP-206: where a drift measurement lives, and when it stops being true.
 *
 * The reading of the plan is pure (`graph/drift.ts`). This module is the only
 * thing that knows a measurement has a home: which documentation of main it
 * lines up with, how a re-measurement replaces the previous one, and — the part
 * that matters most — how we decide a measurement has gone stale.
 *
 * **Staleness is derived, never stored.** A report is stale exactly when the sha
 * it refreshed is no longer the sha main is documented at. Computing it on read
 * means a merge invalidates the measurement by simply happening: no hook on the
 * poller, no row to update, and no way for a "still fresh" flag to be wrong.
 * Drift shown against the wrong sha is worse than no drift at all — it is a
 * confident answer to a question nobody asked.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq } from "drizzle-orm";

import {
  driftReports,
  type DriftReportRow,
  type GraphSnapshotRow,
} from "../db/schema.js";
import {
  parseDriftPlan,
  realityGraph,
  summarizeDrift,
  type DriftReport,
} from "../graph/drift.js";
import { diffPolicyReports, type PolicyDelta } from "../graph/policy/diff.js";
import { ensurePolicyReport, judgeGraph, latestDocsSnapshot } from "./policy.js";

export type RecordDriftInput = {
  repositoryId: string;
  /** The branch that was refreshed — the repository's default branch. */
  ref: string;
  /** The sha of main the refresh ran against. */
  commitSha: string;
  /** The `terraform show -json` of a `-refresh-only` plan. */
  plan: unknown;
};

/**
 * A measurement, plus the two facts a reader needs before believing it: when it
 * was taken, and whether main has moved since.
 */
export type DriftState = {
  id: string;
  repositoryId: string;
  ref: string;
  /** The sha that was measured. */
  commitSha: string;
  /** The documentation snapshot it lines up with; null when main has no diagram. */
  snapshotId: string | null;
  /** The sha main is documented at now; null when it never was. */
  baseCommitSha: string | null;
  /** True when main moved since the measurement — re-measure before believing it. */
  stale: boolean;
  measuredAt: string;
  report: DriftReport;
  summaryMd: string;
};

/**
 * Read a refresh-only plan and store what it found, replacing any previous
 * measurement of the same sha. Throws `NotRefreshOnlyError` when the payload
 * plans anything — the caller turns that into a 422 the CI step can read.
 */
export async function recordDrift(
  db: NodePgDatabase,
  input: RecordDriftInput,
): Promise<DriftReportRow> {
  const parsed = parseDriftPlan(input.plan);

  // The documentation this measurement is *about*, when we have one for that
  // exact sha. Anything else is left null rather than pointed at the nearest
  // diagram: a measurement attached to a picture of a different commit would be
  // exactly the mismatch this story exists to prevent.
  const docs = await docsSnapshotAt(db, input.repositoryId, input.commitSha);
  const snapshotId = docs?.id ?? null;

  // GP-207: the cross-check happens **here**, while the raw plan is still in
  // hand. It is the only moment it can: the stored report keeps masked rows and
  // no raw values, by design, so a verdict computed later would have nothing to
  // read. Stored rather than derived on read, for the reason the pull-request
  // delta is (GP-202) — the panel and the badge must not be able to disagree.
  const policy = docs ? await crossCheck(db, docs, input.plan) : undefined;
  const report: DriftReport = policy
    ? { ...parsed, version: 2, policy }
    : parsed;
  const summaryMd = summarizeDrift(report);
  const now = new Date();

  const [row] = await db
    .insert(driftReports)
    .values({
      repositoryId: input.repositoryId,
      snapshotId,
      ref: input.ref,
      commitSha: input.commitSha,
      report,
      summaryMd,
      measuredAt: now,
    })
    .onConflictDoUpdate({
      target: [driftReports.repositoryId, driftReports.commitSha],
      set: { snapshotId, ref: input.ref, report, summaryMd, measuredAt: now, updatedAt: now },
    })
    .returning();

  return row as DriftReportRow;
}

/** The documentation of main at exactly this sha, or null. */
async function docsSnapshotAt(
  db: NodePgDatabase,
  repositoryId: string,
  commitSha: string,
): Promise<GraphSnapshotRow | null> {
  const docs = await latestDocsSnapshot(db, repositoryId);
  return docs?.commitSha === commitSha ? docs : null;
}

/**
 * What the drift does to compliance (GP-207): the estate as the refresh found it,
 * judged, and compared with the verdict on the code.
 *
 * Read with reality as the head and the code as the base, so the delta's `added`
 * is the answer to the question a security reader is actually asking — *what is
 * wrong out there that is not wrong in the repository?* A violation in both is
 * pre-existing debt the code owns; one only in the code is something somebody
 * already fixed by hand, which the delta calls `resolved`.
 *
 * The reality graph keeps the code's own `source`, so the rules that read HCL
 * give identical verdicts on both sides and can never manufacture an "introduced
 * outside IaC" out of a file nobody touched (see `realityGraph`).
 */
async function crossCheck(
  db: NodePgDatabase,
  docs: GraphSnapshotRow,
  plan: unknown,
): Promise<PolicyDelta | undefined> {
  if (!docs.repositoryId) return undefined;
  const reality = await judgeGraph(
    db,
    docs.repositoryId,
    realityGraph(docs.graph, plan),
    "terraform",
  );
  const code = await ensurePolicyReport(db, docs);
  return diffPolicyReports(reality, { report: code.report, snapshotId: docs.id });
}

/** The newest measurement of a repository, or null when nobody ever ran one. */
export async function latestDriftReport(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<DriftReportRow | null> {
  const [row] = await db
    .select()
    .from(driftReports)
    .where(eq(driftReports.repositoryId, repositoryId))
    .orderBy(desc(driftReports.measuredAt))
    .limit(1);
  return row ?? null;
}

/**
 * The newest measurement, judged against the main anybody is looking at.
 *
 * Null when there is none: a repository nobody has measured has no drift state,
 * and inventing an empty one would say "no drift" where the truth is "nobody
 * asked" — the same fail-honest posture the compliance list takes (GP-203).
 */
export async function driftStateFor(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<DriftState | null> {
  const row = await latestDriftReport(db, repositoryId);
  if (!row) return null;
  const docs = await latestDocsSnapshot(db, repositoryId);
  return driftStateOf(row, docs?.commitSha ?? null);
}

/**
 * Assemble the state from a row and main's current sha. Split out so a caller
 * that already knows main's sha (the dashboard, which reads every repository at
 * once) does not go back to the database for each one.
 */
export function driftStateOf(
  row: DriftReportRow,
  baseCommitSha: string | null,
): DriftState {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    ref: row.ref,
    commitSha: row.commitSha,
    snapshotId: row.snapshotId,
    baseCommitSha,
    // With no documented main there is nothing for the measurement to disagree
    // with, so it is not stale — it is simply unanchored, which `snapshotId:
    // null` already says.
    stale: baseCommitSha !== null && baseCommitSha !== row.commitSha,
    measuredAt: row.measuredAt.toISOString(),
    report: row.report,
    summaryMd: row.summaryMd,
  };
}

/** The newest measurement of each of the given repositories, keyed by repo id. */
export async function driftReportsFor(
  db: NodePgDatabase,
  repositoryIds: string[],
): Promise<Map<string, DriftReportRow>> {
  if (repositoryIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([driftReports.repositoryId])
    .from(driftReports)
    .orderBy(driftReports.repositoryId, desc(driftReports.measuredAt));
  return new Map(
    rows
      .filter((row) => repositoryIds.includes(row.repositoryId))
      .map((row) => [row.repositoryId, row]),
  );
}

/** The measurement of one exact sha, when the caller knows which one it wants. */
export async function driftReportAt(
  db: NodePgDatabase,
  repositoryId: string,
  commitSha: string,
): Promise<DriftReportRow | null> {
  const [row] = await db
    .select()
    .from(driftReports)
    .where(
      and(
        eq(driftReports.repositoryId, repositoryId),
        eq(driftReports.commitSha, commitSha),
      ),
    );
  return row ?? null;
}
