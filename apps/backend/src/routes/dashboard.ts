import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import {
  annotations,
  graphSnapshots,
  projects,
  pullRequests,
  repositories,
} from "../db/schema.js";
import type { GraphStats } from "../graph/graph.js";
import { DOCS_SOURCES } from "../services/graph-snapshots.js";

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
  app.get("/dashboard", async () => {
    const [stats, prs, docs, orphanRepositories] = await Promise.all([
      loadStats(),
      loadRecentPrs(),
      loadRecentDocs(),
      loadOrphanRepositories(),
    ]);
    return { stats, recentPrs: prs, recentDocsSnapshots: docs, orphanRepositories };
  });

  async function loadStats() {
    const [projectCount, repositoryCount, openPrCount, orphanCount] =
      await Promise.all([
        app.db.select({ n: count() }).from(projects),
        app.db.select({ n: count() }).from(repositories),
        app.db
          .select({ n: count() })
          .from(pullRequests)
          .where(eq(pullRequests.state, "open")),
        app.db
          .select({ n: count() })
          .from(annotations)
          .where(eq(annotations.status, "orphaned")),
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
  async function loadRecentPrs() {
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
          eq(graphSnapshots.source, "plan"),
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
  async function loadRecentDocs() {
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
      // Every producer that documents a default branch, Terraform or Kubernetes
      // (GP-102) — the card is about documentation, not about a language.
      .where(inArray(graphSnapshots.source, DOCS_SOURCES))
      .orderBy(desc(graphSnapshots.createdAt))
      .limit(RECENT_DOCS);

    return rows.map(({ stats, ...row }) => ({
      ...row,
      trigger: stats.trigger === "auto" ? "auto" : "manual",
    }));
  }

  /**
   * The repositories holding orphaned annotations, worst first — so the orphan
   * stat card can link straight to a repository's orphan review (GP-59).
   */
  async function loadOrphanRepositories() {
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
      .where(eq(annotations.status, "orphaned"))
      .groupBy(repositories.id)
      .orderBy(desc(orphans));
  }
};
