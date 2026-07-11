import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { and, eq } from "drizzle-orm";

import { graphSnapshots, repositories, shareTokens } from "../db/schema.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  cachedSnapshotExport,
  type ExportFormat,
  type ExportScope,
} from "../services/snapshot-export.js";
import {
  createShareLink,
  listShareLinks,
  resolveShareToken,
  revokeShareLink,
  toPublicShareLink,
  toPublicSnapshotView,
} from "../services/share-links.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const tokenParamsSchema = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  // base64url token (see lib/tokens.generateToken).
  properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } },
};

const scopeQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { scope: { type: "string", enum: ["full", "changes"] } },
};

const createBodySchema = {
  type: "object",
  required: ["kind"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["docs_latest", "snapshot"] },
    snapshotId: { type: "string", pattern: UUID_PATTERN },
  },
  allOf: [
    {
      if: { properties: { kind: { const: "snapshot" } } },
      then: { required: ["snapshotId"] },
    },
  ],
};

async function repoExists(app: FastifyInstance, id: string): Promise<boolean> {
  const [repo] = await app.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, id));
  return Boolean(repo);
}

export const shareRoutes: FastifyPluginAsync = async (app) => {
  // --- Authenticated management -------------------------------------------

  app.post(
    "/repositories/:id/share-links",
    { schema: { params: idParamsSchema, body: createBodySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { kind: "docs_latest" | "snapshot"; snapshotId?: string };
      if (!(await repoExists(app, id))) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      // A pinned link must reference a snapshot that belongs to this repository.
      if (body.kind === "snapshot") {
        const [snap] = await app.db
          .select({ id: graphSnapshots.id })
          .from(graphSnapshots)
          .where(
            and(
              eq(graphSnapshots.id, body.snapshotId!),
              eq(graphSnapshots.repositoryId, id),
            ),
          );
        if (!snap) {
          return reply.code(422).send({
            error: "Unprocessable Entity",
            message: "snapshot does not belong to this repository",
          });
        }
      }

      const row = await createShareLink(app.db, {
        repositoryId: id,
        kind: body.kind,
        snapshotId: body.snapshotId ?? null,
        createdBy: request.authUser?.id ?? null,
      });
      return reply.code(201).send(toPublicShareLink(row));
    },
  );

  app.get(
    "/repositories/:id/share-links",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await repoExists(app, id))) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      const rows = await listShareLinks(app.db, id);
      return rows.map(toPublicShareLink);
    },
  );

  app.delete(
    "/share-links/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [existing] = await app.db
        .select({ id: shareTokens.id })
        .from(shareTokens)
        .where(eq(shareTokens.id, id));
      if (!existing) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "share link not found" });
      }
      await revokeShareLink(app.db, id);
      return reply.code(204).send();
    },
  );

  // --- Public (no auth, rate-limited) -------------------------------------
  // Encapsulated so the per-IP limiter hook covers only these routes.
  await app.register(async (pub) => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 240 });
    pub.addHook("onRequest", async (request, reply) => {
      if (!limiter.check(request.ip)) {
        return reply
          .code(429)
          .send({ error: "Too Many Requests", message: "rate limit exceeded" });
      }
    });

    pub.get(
      "/public/:token",
      { schema: { params: tokenParamsSchema } },
      async (request, reply) => {
        const { token } = request.params as { token: string };
        const resolved = await resolveShareToken(app.db, token);
        if (!resolved) {
          return reply
            .code(404)
            .send({ error: "Not Found", message: "share link not found" });
        }
        return toPublicSnapshotView(resolved);
      },
    );

    const exportHandler =
      (format: ExportFormat) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { token } = request.params as { token: string };
        const scope: ExportScope =
          (request.query as { scope?: ExportScope }).scope ?? "full";
        const resolved = await resolveShareToken(app.db, token);
        if (!resolved) {
          return reply
            .code(404)
            .send({ error: "Not Found", message: "share link not found" });
        }
        const { body, contentType, cached } = await cachedSnapshotExport(
          app.exportCacheDir,
          { snapshot: resolved.snapshot, repoUrl: resolved.repoUrl, format, scope },
        );
        return reply
          .header("content-type", contentType)
          .header("cache-control", "public, max-age=300")
          .header("x-groundplan-cache", cached ? "hit" : "miss")
          .send(body);
      };

    pub.get(
      "/public/:token/export.svg",
      { schema: { params: tokenParamsSchema, querystring: scopeQuerySchema } },
      exportHandler("svg"),
    );
    pub.get(
      "/public/:token/export.png",
      { schema: { params: tokenParamsSchema, querystring: scopeQuerySchema } },
      exportHandler("png"),
    );
  });
};
