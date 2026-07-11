import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, type SQL } from "drizzle-orm";

import {
  graphSnapshots,
  publicSnapshotColumns,
  repositories,
} from "../db/schema.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
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
};
