import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";

import { graphSnapshots, repositories } from "../db/schema.js";
import {
  cachedSnapshotExport,
  type ExportFormat,
  type ExportScope,
} from "../services/snapshot-export.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const scopeQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { scope: { type: "string", enum: ["full", "changes"] } },
};

export const exportRoutes: FastifyPluginAsync = async (app) => {
  const handle =
    (format: ExportFormat) => async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const scope: ExportScope =
        (request.query as { scope?: ExportScope }).scope ?? "full";

      const [snapshot] = await app.db
        .select()
        .from(graphSnapshots)
        .where(eq(graphSnapshots.id, id));
      if (!snapshot) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }

      const [repo] = await app.db
        .select({ url: repositories.url })
        .from(repositories)
        .where(eq(repositories.id, snapshot.repositoryId));

      const { body, contentType, cached } = await cachedSnapshotExport(
        app.exportCacheDir,
        { snapshot, repoUrl: repo?.url ?? "", format, scope },
      );

      return reply
        .header("content-type", contentType)
        .header("cache-control", "public, max-age=300")
        .header("x-groundplan-cache", cached ? "hit" : "miss")
        .send(body);
    };

  app.get(
    "/snapshots/:id/export.svg",
    { schema: { params: idParamsSchema, querystring: scopeQuerySchema } },
    handle("svg"),
  );

  app.get(
    "/snapshots/:id/export.png",
    { schema: { params: idParamsSchema, querystring: scopeQuerySchema } },
    handle("png"),
  );
};
