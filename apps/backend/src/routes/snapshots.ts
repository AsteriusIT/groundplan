import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import {
  graphSnapshots,
  publicSnapshotColumns,
  repositories,
} from "../db/schema.js";
import { diffGraphs } from "../graph/diff.js";

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
