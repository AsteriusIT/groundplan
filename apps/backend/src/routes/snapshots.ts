import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import {
  annotations,
  graphSnapshots,
  publicSnapshotColumns,
  repositories,
} from "../db/schema.js";
import { collapseToGroups, projectAdapted } from "../graph/adapted.js";
import { diffGraphs } from "../graph/diff.js";
import { computeGraphStats } from "../graph/graph.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const diffParamsSchema = {
  type: "object",
  required: ["id", "otherId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    otherId: { type: "string", pattern: UUID_PATTERN },
  },
};

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", enum: ["plan", "hcl"] },
    // Coerced from the query string by Fastify's schema validation.
    pr_number: { type: "integer" },
  },
};

const adaptedQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    /** `group` = the C4 view: one node per top-level group (GP-77). */
    granularity: { type: "string", enum: ["resource", "group"] },
    /** Annotation id of the single group to leave open inside the C4 view. */
    expandGroup: { type: "string", pattern: UUID_PATTERN },
  },
};

export const snapshotRoutes: FastifyPluginAsync = async (app) => {
  // List a repository's snapshots (metadata + stats, never the graph body).
  app.get(
    "/repositories/:id/snapshots",
    { schema: { params: idParamsSchema, querystring: listQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { source?: "plan" | "hcl"; pr_number?: number };

      const [repo] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, id));
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const filters: SQL[] = [eq(graphSnapshots.repositoryId, id)];
      if (query.source) filters.push(eq(graphSnapshots.source, query.source));
      if (query.pr_number !== undefined) {
        filters.push(eq(graphSnapshots.prNumber, query.pr_number));
      }

      return app.db
        .select(publicSnapshotColumns)
        .from(graphSnapshots)
        .where(and(...filters))
        .orderBy(desc(graphSnapshots.createdAt));
    },
  );

  // Full snapshot including the graph body.
  app.get(
    "/snapshots/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [row] = await app.db
        .select()
        .from(graphSnapshots)
        .where(eq(graphSnapshots.id, id));
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }
      return row;
    },
  );

  /**
   * The adapted snapshot (GP-72): the same graph, seen through the repository's
   * accepted annotations — groups as containers, hidden nodes gone, logical
   * edges drawn, renames applied.
   *
   * It returns a snapshot in the ordinary shape, so the renderer needs to know
   * nothing about annotations to draw it (ADR #2). Computed per request: the
   * projection is a pure fold over data we already hold, and caching it would
   * only buy us a staleness bug (ADR #7).
   *
   * `granularity=group` collapses it to one node per top-level group — the C4
   * view (GP-77) — and `expandGroup` opens exactly one of them, which is the
   * drill-down. Both are ways of *looking* at the same fold, which is why they
   * are parameters here rather than a second endpoint.
   */
  app.get(
    "/snapshots/:id/adapted",
    { schema: { params: idParamsSchema, querystring: adaptedQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        granularity?: "resource" | "group";
        expandGroup?: string;
      };

      const [row] = await app.db
        .select()
        .from(graphSnapshots)
        .where(eq(graphSnapshots.id, id));
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }

      const layer = await app.db
        .select()
        .from(annotations)
        .where(eq(annotations.repositoryId, row.repositoryId));

      const adapted = projectAdapted(row.graph, layer);
      const graph =
        query.granularity === "group"
          ? collapseToGroups(adapted, {
              ...(query.expandGroup ? { expandGroup: query.expandGroup } : {}),
            })
          : adapted;

      return {
        ...row,
        graph,
        // The counts describe the graph we are handing back, not the one we
        // started from — a hidden node is not in this picture, so it is not in
        // this picture's stats. Warnings are about the *parse*, so they survive.
        stats: { ...computeGraphStats(graph), warnings: row.stats.warnings ?? [] },
      };
    },
  );

  // Diff two docs snapshots (GP-40): what appeared / disappeared / moved between
  // base (:id) and target (:otherId). Both must be hcl snapshots of one repo.
  app.get(
    "/snapshots/:id/diff/:otherId",
    { schema: { params: diffParamsSchema } },
    async (request, reply) => {
      const { id, otherId } = request.params as { id: string; otherId: string };

      const rows = await app.db
        .select()
        .from(graphSnapshots)
        .where(inArray(graphSnapshots.id, [id, otherId]));
      const base = rows.find((r) => r.id === id);
      const target = rows.find((r) => r.id === otherId);
      if (!base || !target) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }

      if (base.repositoryId !== target.repositoryId) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "snapshots belong to different repositories",
        });
      }
      if (base.source !== "hcl" || target.source !== "hcl") {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "diff is only supported between documentation (hcl) snapshots",
        });
      }

      return {
        base: { id: base.id, commitSha: base.commitSha, createdAt: base.createdAt },
        target: { id: target.id, commitSha: target.commitSha, createdAt: target.createdAt },
        ...diffGraphs(base.graph, target.graph),
      };
    },
  );
};
