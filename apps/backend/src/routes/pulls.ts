import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";

import {
  graphSnapshots,
  ingestionEvents,
  pullRequests,
  repositories,
  type PullRequestRow,
} from "../db/schema.js";
import { PR_SOURCES } from "../services/graph-snapshots.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const pullParamsSchema = {
  type: "object",
  required: ["id", "number"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    number: { type: "integer", minimum: 1 },
  },
};

/**
 * The PR list is filtered by state (GP-109). It defaults to `open`, because a
 * closed PR is history: git has decided its branch is gone, and the day-to-day
 * list is what is still in flight. `?status=closed` returns the history; `all`
 * returns both.
 */
const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["open", "closed", "all"], default: "open" },
  },
};

type SnapshotSummary = { id: string; stats: unknown; createdAt: Date };

function toPublicPull(row: PullRequestRow) {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    number: row.number,
    title: row.title,
    state: row.state,
    /** When the PR was soft-closed (GP-109); null while open. */
    closedAt: row.closedAt,
    sourceRef: row.sourceRef,
    latestCommitSha: row.latestCommitSha,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function repoExists(app: FastifyInstance, id: string): Promise<boolean> {
  const [repo] = await app.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, id));
  return Boolean(repo);
}

/**
 * The most recent head snapshot for each PR number (stats only, no graph) —
 * a Terraform plan, or the manifests the CI rendered (GP-103). Which producer
 * made it is the repository's business, not this list's.
 */
async function latestSnapshotsByPr(
  app: FastifyInstance,
  repositoryId: string,
): Promise<Map<number, SnapshotSummary>> {
  const rows = await app.db
    .select({
      id: graphSnapshots.id,
      prNumber: graphSnapshots.prNumber,
      stats: graphSnapshots.stats,
      createdAt: graphSnapshots.createdAt,
    })
    .from(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, repositoryId),
        inArray(graphSnapshots.source, PR_SOURCES),
      ),
    )
    .orderBy(desc(graphSnapshots.createdAt));

  const latest = new Map<number, SnapshotSummary>();
  for (const row of rows) {
    if (row.prNumber !== null && !latest.has(row.prNumber)) {
      latest.set(row.prNumber, {
        id: row.id,
        stats: row.stats,
        createdAt: row.createdAt,
      });
    }
  }
  return latest;
}

export const pullRoutes: FastifyPluginAsync = async (app) => {
  // List a repository's pull requests, newest first, each with the stats of its
  // latest plan snapshot (never the graph body).
  app.get(
    "/repositories/:id/pulls",
    { schema: { params: idParamsSchema, querystring: listQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status = "open" } = request.query as {
        status?: "open" | "closed" | "all";
      };
      if (!(await repoExists(app, id))) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const stateFilter =
        status === "all"
          ? eq(pullRequests.repositoryId, id)
          : and(
              eq(pullRequests.repositoryId, id),
              eq(pullRequests.state, status),
            );

      const [pulls, latest] = await Promise.all([
        app.db
          .select()
          .from(pullRequests)
          .where(stateFilter)
          .orderBy(desc(pullRequests.updatedAt)),
        latestSnapshotsByPr(app, id),
      ]);

      return pulls.map((pull) => ({
        ...toPublicPull(pull),
        latestSnapshot: latest.get(pull.number) ?? null,
      }));
    },
  );

  // A single pull request: metadata + its latest snapshot summary. When there is
  // no snapshot, surface the parse error from the matching ingestion event so
  // the PR view can explain the empty state (GP-17).
  app.get(
    "/repositories/:id/pulls/:number",
    { schema: { params: pullParamsSchema } },
    async (request, reply) => {
      const { id, number } = request.params as { id: string; number: number };
      if (!(await repoExists(app, id))) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const [pull] = await app.db
        .select()
        .from(pullRequests)
        .where(
          and(eq(pullRequests.repositoryId, id), eq(pullRequests.number, number)),
        );
      if (!pull) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "pull request not found" });
      }

      const latest = await latestSnapshotsByPr(app, id);
      const latestSnapshot = latest.get(pull.number) ?? null;

      let parseError: string | null = null;
      if (!latestSnapshot) {
        const [event] = await app.db
          .select({ parseError: ingestionEvents.parseError })
          .from(ingestionEvents)
          .where(
            and(
              eq(ingestionEvents.repositoryId, id),
              eq(ingestionEvents.commitSha, pull.latestCommitSha),
            ),
          )
          .orderBy(desc(ingestionEvents.receivedAt))
          .limit(1);
        parseError = event?.parseError ?? null;
      }

      return { ...toPublicPull(pull), latestSnapshot, parseError };
    },
  );
};
