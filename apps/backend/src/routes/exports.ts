import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";

import { graphSnapshots, repositories } from "../db/schema.js";
import {
  cachedSnapshotExport,
  canonicalViews,
  repoLabel,
  type ExportFormat,
  type ExportScope,
  type ExportView,
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

// draw.io always exports the full snapshot (GP-177); unknown query params are
// stripped by validation, so a stray ?scope= cannot change the output. `views`
// is a comma list of lenses (mirroring the app's view switcher) — each becomes
// one page of the file.
const drawioQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    views: { type: "string", pattern: "^(infra|network|iam)(,(infra|network|iam)){0,2}$" },
  },
};

export const exportRoutes: FastifyPluginAsync = async (app) => {
  const handle =
    (format: ExportFormat) => async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const scope: ExportScope =
        format === "drawio"
          ? "full"
          : ((request.query as { scope?: ExportScope }).scope ?? "full");

      const [snapshot] = await app.db
        .select()
        .from(graphSnapshots)
        .where(eq(graphSnapshots.id, id));
      if (!snapshot) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }

      // The repository URL is only a caption on the render. A Kubernetes snapshot
      // (GP-97) has a cluster instead of a repository, and exports fine without it.
      const [repo] = snapshot.repositoryId
        ? await app.db
            .select({ url: repositories.url })
            .from(repositories)
            .where(eq(repositories.id, snapshot.repositoryId))
        : [];

      const rawViews =
        format === "drawio" ? (request.query as { views?: string }).views : undefined;
      const views = canonicalViews(rawViews?.split(",") as ExportView[] | undefined);

      const { body, contentType, cached } = await cachedSnapshotExport(
        app.exportCacheDir,
        { snapshot, repoUrl: repo?.url ?? "", format, scope, views },
      );

      if (format === "drawio") {
        const viewPart = views.length === 1 && views[0] === "infra" ? "" : views.join("-");
        const base =
          [
            repoLabel(repo?.url ?? "").replaceAll("/", "-"),
            snapshot.commitSha.slice(0, 8),
            viewPart,
          ]
            .filter(Boolean)
            .join("-") || "snapshot";
        reply.header("content-disposition", `attachment; filename="${base}.drawio"`);
      }

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

  app.get(
    "/snapshots/:id/export.drawio",
    { schema: { params: idParamsSchema, querystring: drawioQuerySchema } },
    handle("drawio"),
  );
};
