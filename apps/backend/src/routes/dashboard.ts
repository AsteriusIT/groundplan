import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import {
  annotations,
  driftReports,
  graphSnapshots,
  policyReports,
  projects,
  pullRequests,
  repositories,
} from "../db/schema.js";
import type { GraphStats } from "../graph/graph.js";
import type { PolicyStatus } from "../graph/policy/types.js";
import { orgIdOf } from "../rbac/request.js";
import { DOCS_SOURCES, PR_SOURCES } from "../services/graph-snapshots.js";

/** How much recent activity the dashboard shows. Fixed — no pagination (GP-67). */
const RECENT_PRS = 10;
const RECENT_DOCS = 5;

type SnapshotRef = { id: string; stats: GraphStats; createdAt: Date };

/** The risk flags a plan snapshot carries, derived from its graph nodes. */
type Risk = { internetExposed: boolean; privileged: boolean };

/**
 * Whether any node in a snapshot's graph carries `flag: true`. Evaluated by
 * Postgres (jsonb containment) rather than by loading graphs into memory — the
 * graph body is the one column on this table we never want to ship around.
 */
function anyNodeHas(flag: "internet_exposed" | "privileged") {
  return sql<boolean>`${graphSnapshots.graph} -> 'nodes' @> ${JSON.stringify([
    { [flag]: true },
  ])}::jsonb`;
}

/** Worst compliance state first — the dashboard opens on what needs answering. */
const STATUS_ORDER: Record<PolicyStatus, number> = {
  failing: 0,
  warnings: 1,
  passing: 2,
};

/** `${repositoryId}#${prNumber}` — the identity of a pull request across repos. */
function prKey(repositoryId: string, number: number): string {
  return `${repositoryId}#${number}`;
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Everything the home page shows, in one read-only call (GP-67): a few counts,
   * the last pull requests, and the last documentation snapshots.
   *
   * Scope: the whole estate. There is no per-user ownership model yet — every
   * authenticated user sees the same projects (auth is the global onRequest hook,
   * GP-6). When ownership lands, this is the one place to scope.
   */
  app.get("/dashboard", async (request) => {
    const orgId = orgIdOf(request);
    const [stats, prs, docs, orphanRepositories, compliance, drift] =
      await Promise.all([
        loadStats(orgId),
        loadRecentPrs(orgId),
        loadRecentDocs(orgId),
        loadOrphanRepositories(orgId),
        loadCompliance(orgId),
        loadDrift(orgId),
      ]);
    return {
      stats,
      recentPrs: prs,
      recentDocsSnapshots: docs,
      orphanRepositories,
      compliance,
      drift,
    };
  });

  async function loadStats(orgId: string) {
    const [projectCount, repositoryCount, openPrCount, orphanCount] =
      await Promise.all([
        app.db
          .select({ n: count() })
          .from(projects)
          .where(eq(projects.organizationId, orgId)),
        app.db
          .select({ n: count() })
          .from(repositories)
          .innerJoin(projects, eq(repositories.projectId, projects.id))
          .where(eq(projects.organizationId, orgId)),
        app.db
          .select({ n: count() })
          .from(pullRequests)
          .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
          .innerJoin(projects, eq(repositories.projectId, projects.id))
          .where(
            and(
              eq(pullRequests.state, "open"),
              eq(projects.organizationId, orgId),
            ),
          ),
        app.db
          .select({ n: count() })
          .from(annotations)
          .innerJoin(repositories, eq(annotations.repositoryId, repositories.id))
          .innerJoin(projects, eq(repositories.projectId, projects.id))
          .where(
            and(
              eq(annotations.status, "orphaned"),
              eq(projects.organizationId, orgId),
            ),
          ),
      ]);

    return {
      projects: projectCount[0]?.n ?? 0,
      repositories: repositoryCount[0]?.n ?? 0,
      openPrs: openPrCount[0]?.n ?? 0,
      orphanedAnnotations: orphanCount[0]?.n ?? 0,
    };
  }

  /**
   * The most recently touched pull requests across every repository, each with
   * the stats and risk flags of its latest plan snapshot. A PR whose plan never
   * parsed has no snapshot and no flags — it still lists (GP-17).
   */
  async function loadRecentPrs(orgId: string) {
    const pulls = await app.db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        sourceRef: pullRequests.sourceRef,
        updatedAt: pullRequests.updatedAt,
        repositoryId: repositories.id,
        repositoryUrl: repositories.url,
        targetRef: repositories.defaultBranch,
        projectId: repositories.projectId,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .innerJoin(projects, eq(repositories.projectId, projects.id))
      .where(eq(projects.organizationId, orgId))
      .orderBy(desc(pullRequests.updatedAt))
      .limit(RECENT_PRS);

    if (pulls.length === 0) return [];

    const latest = await latestPlanSnapshots(
      [...new Set(pulls.map((p) => p.repositoryId))],
      [...new Set(pulls.map((p) => p.number))],
    );

    return pulls.map((pull) => {
      const found = latest.get(prKey(pull.repositoryId, pull.number));
      return {
        ...pull,
        latestSnapshot: found?.snapshot ?? null,
        internetExposed: found?.risk.internetExposed ?? false,
        privileged: found?.risk.privileged ?? false,
      };
    });
  }

  /**
   * The newest plan snapshot of each (repository, PR) pair among the given ones,
   * with its risk flags. `DISTINCT ON` keeps one row per pair, so the containment
   * checks only run on the snapshots that survive the dedup.
   */
  async function latestPlanSnapshots(
    repositoryIds: string[],
    prNumbers: number[],
  ): Promise<Map<string, { snapshot: SnapshotRef; risk: Risk }>> {
    const rows = await app.db
      .selectDistinctOn([graphSnapshots.repositoryId, graphSnapshots.prNumber], {
        id: graphSnapshots.id,
        repositoryId: graphSnapshots.repositoryId,
        prNumber: graphSnapshots.prNumber,
        stats: graphSnapshots.stats,
        createdAt: graphSnapshots.createdAt,
        internetExposed: anyNodeHas("internet_exposed"),
        privileged: anyNodeHas("privileged"),
      })
      .from(graphSnapshots)
      .where(
        and(
          // Every producer that describes a pull request's head (GP-103) — the
          // chips count changes, and a change is a change whatever wrote it.
          inArray(graphSnapshots.source, PR_SOURCES),
          inArray(graphSnapshots.repositoryId, repositoryIds),
          inArray(graphSnapshots.prNumber, prNumbers),
        ),
      )
      .orderBy(
        graphSnapshots.repositoryId,
        graphSnapshots.prNumber,
        desc(graphSnapshots.createdAt),
      );

    const latest = new Map<string, { snapshot: SnapshotRef; risk: Risk }>();
    for (const row of rows) {
      // A plan snapshot always has both (it came from a repository's CI); the
      // types allow neither, because a Kubernetes snapshot has a cluster instead.
      if (row.prNumber === null || row.repositoryId === null) continue;
      latest.set(prKey(row.repositoryId, row.prNumber), {
        snapshot: { id: row.id, stats: row.stats, createdAt: row.createdAt },
        risk: {
          internetExposed: row.internetExposed,
          privileged: row.privileged,
        },
      });
    }
    return latest;
  }

  /** The last documentation snapshots, newest first. `trigger` lives in stats (GP-23). */
  async function loadRecentDocs(orgId: string) {
    const rows = await app.db
      .select({
        id: graphSnapshots.id,
        commitSha: graphSnapshots.commitSha,
        stats: graphSnapshots.stats,
        createdAt: graphSnapshots.createdAt,
        repositoryId: repositories.id,
        repositoryUrl: repositories.url,
        projectId: repositories.projectId,
      })
      .from(graphSnapshots)
      .innerJoin(repositories, eq(graphSnapshots.repositoryId, repositories.id))
      .innerJoin(projects, eq(repositories.projectId, projects.id))
      // Every producer that documents a default branch, Terraform or Kubernetes
      // (GP-102) — the card is about documentation, not about a language.
      .where(
        and(
          inArray(graphSnapshots.source, DOCS_SOURCES),
          eq(projects.organizationId, orgId),
        ),
      )
      .orderBy(desc(graphSnapshots.createdAt))
      .limit(RECENT_DOCS);

    return rows.map(({ stats, ...row }) => ({
      ...row,
      trigger: stats.trigger === "auto" ? "auto" : "manual",
    }));
  }

  /**
   * Where each repository stands against the policy (GP-203): the verdict on its
   * current documentation of main, with the counts behind it.
   *
   * Read from the stored report rather than re-evaluated — the engine is
   * deterministic, so a dashboard that re-ran it would spend the estate's CPU to
   * learn what is already written down. A repository whose main has never been
   * documented, or never judged, is simply absent: this list says what is known,
   * and inventing a `passing` for an unread repository would be a lie the whole
   * epic exists to avoid.
   *
   * Worst first, so the list opens on what needs answering.
   */
  async function loadCompliance(orgId: string) {
    const rows = await app.db
      .selectDistinctOn([graphSnapshots.repositoryId], {
        repositoryId: repositories.id,
        repositoryUrl: repositories.url,
        projectId: repositories.projectId,
        snapshotId: graphSnapshots.id,
        commitSha: graphSnapshots.commitSha,
        report: policyReports.report,
        evaluatedAt: policyReports.updatedAt,
      })
      .from(graphSnapshots)
      .innerJoin(policyReports, eq(policyReports.snapshotId, graphSnapshots.id))
      .innerJoin(repositories, eq(graphSnapshots.repositoryId, repositories.id))
      .innerJoin(projects, eq(repositories.projectId, projects.id))
      .where(
        and(
          inArray(graphSnapshots.source, DOCS_SOURCES),
          eq(projects.organizationId, orgId),
        ),
      )
      .orderBy(
        graphSnapshots.repositoryId,
        desc(graphSnapshots.createdAt),
      );

    return rows
      .map(({ report, ...row }) => ({
        ...row,
        status: report.status,
        counts: report.counts,
        checkedRules: report.rules.filter((r) => r.enabled && r.applicable).length,
      }))
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          b.counts.error - a.counts.error ||
          b.counts.warning - a.counts.warning ||
          a.repositoryUrl.localeCompare(b.repositoryUrl),
      );
  }

  /**
   * Where each repository stands against reality (GP-207): the newest drift
   * measurement, how much it found, and whether it still describes the main
   * anybody is looking at.
   *
   * A repository nobody has measured is **absent**, exactly as it is from the
   * compliance list: drift is opt-in, and a row saying "0 drifted" for an estate
   * nobody refreshed would be the most reassuring lie in the product.
   *
   * Staleness is derived here too, by joining the measurement's sha against the
   * sha main is currently documented at. `DISTINCT ON` keeps the newest
   * measurement per repository and the newest documentation per repository, so
   * both sides of that comparison are the current ones.
   *
   * Worst first: stale before fresh (a measurement you cannot trust is the one to
   * act on), then most drifted.
   */
  async function loadDrift(orgId: string) {
    const [measurements, documented] = await Promise.all([
      app.db
        .selectDistinctOn([driftReports.repositoryId], {
          repositoryId: driftReports.repositoryId,
          repositoryUrl: repositories.url,
          projectId: repositories.projectId,
          ref: driftReports.ref,
          commitSha: driftReports.commitSha,
          report: driftReports.report,
          measuredAt: driftReports.measuredAt,
        })
        .from(driftReports)
        .innerJoin(repositories, eq(driftReports.repositoryId, repositories.id))
        .innerJoin(projects, eq(repositories.projectId, projects.id))
        .where(eq(projects.organizationId, orgId))
        .orderBy(driftReports.repositoryId, desc(driftReports.measuredAt)),
      app.db
        .selectDistinctOn([graphSnapshots.repositoryId], {
          repositoryId: graphSnapshots.repositoryId,
          commitSha: graphSnapshots.commitSha,
        })
        .from(graphSnapshots)
        .innerJoin(repositories, eq(graphSnapshots.repositoryId, repositories.id))
        .innerJoin(projects, eq(repositories.projectId, projects.id))
        .where(
          and(
            inArray(graphSnapshots.source, DOCS_SOURCES),
            eq(projects.organizationId, orgId),
          ),
        )
        .orderBy(graphSnapshots.repositoryId, desc(graphSnapshots.createdAt)),
    ]);

    const mainSha = new Map(
      documented
        .filter((row) => row.repositoryId !== null)
        .map((row) => [row.repositoryId as string, row.commitSha]),
    );

    return measurements
      .map(({ report, measuredAt, ...row }) => {
        const baseCommitSha = mainSha.get(row.repositoryId) ?? null;
        return {
          ...row,
          baseCommitSha,
          stale: baseCommitSha !== null && baseCommitSha !== row.commitSha,
          drifted: report.counts.total,
          deleted: report.counts.deleted,
          /** GP-207: violations that exist in the cloud and not in the code. */
          outsideIac: report.policy?.added.length ?? 0,
          measuredAt,
        };
      })
      .sort(
        (a, b) =>
          Number(b.stale) - Number(a.stale) ||
          b.outsideIac - a.outsideIac ||
          b.drifted - a.drifted ||
          a.repositoryUrl.localeCompare(b.repositoryUrl),
      );
  }

  /**
   * The repositories holding orphaned annotations, worst first — so the orphan
   * stat card can link straight to a repository's orphan review (GP-59).
   */
  async function loadOrphanRepositories(orgId: string) {
    const orphans = count();
    return app.db
      .select({
        repositoryId: repositories.id,
        repositoryUrl: repositories.url,
        projectId: repositories.projectId,
        count: orphans,
      })
      .from(annotations)
      .innerJoin(repositories, eq(annotations.repositoryId, repositories.id))
      .innerJoin(projects, eq(repositories.projectId, projects.id))
      .where(
        and(
          eq(annotations.status, "orphaned"),
          eq(projects.organizationId, orgId),
        ),
      )
      .groupBy(repositories.id)
      .orderBy(desc(orphans));
  }
};
