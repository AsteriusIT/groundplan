import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
} from "fastify";
import { eq } from "drizzle-orm";

import { repositories } from "../db/schema.js";
import {
  getFile,
  listFiles,
  PathTraversalError,
  type RepoSource,
} from "../services/repo-files.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const filesParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const refQuerySchema = {
  type: "object",
  properties: { ref: { type: "string", minLength: 1, maxLength: 200 } },
};

type RepoRow = typeof repositories.$inferSelect;

/**
 * Load the repository and resolve the git ref/source for a file request.
 * Sends the appropriate error response and returns null when unusable.
 */
async function resolveSource(
  db: FastifyInstance["db"],
  id: string,
  ref: string | undefined,
  reply: FastifyReply,
): Promise<RepoSource | null> {
  const [repo]: RepoRow[] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id));

  if (!repo) {
    reply.code(404).send({ error: "Not Found", message: "repository not found" });
    return null;
  }

  let protocol: string;
  try {
    protocol = new URL(repo.url).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "https:") {
    reply.code(400).send({
      error: "Bad Request",
      message: "only https repository URLs are supported",
    });
    return null;
  }

  return {
    url: repo.url,
    provider: repo.provider,
    ref: ref ?? repo.defaultBranch,
    accessToken: repo.accessToken,
  };
}

export const repositoryFileRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/repositories/:id/files",
    { schema: { params: filesParamsSchema, querystring: refQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { ref } = request.query as { ref?: string };

      const source = await resolveSource(app.db, id, ref, reply);
      if (!source) return reply;

      try {
        return await listFiles(source);
      } catch (err) {
        request.log.error({ err, repositoryId: id }, "failed to list files");
        return reply.code(502).send({
          error: "Bad Gateway",
          message: "failed to read repository",
        });
      }
    },
  );

  app.get(
    "/repositories/:id/files/*",
    { schema: { params: filesParamsSchema, querystring: refQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const filePath = (request.params as Record<string, string>)["*"] ?? "";
      const { ref } = request.query as { ref?: string };

      const source = await resolveSource(app.db, id, ref, reply);
      if (!source) return reply;

      try {
        const file = await getFile({ ...source, filePath });
        if (!file) {
          return reply
            .code(404)
            .send({ error: "Not Found", message: "file not found" });
        }
        return reply.type(file.contentType).send(file.content);
      } catch (err) {
        if (err instanceof PathTraversalError) {
          return reply
            .code(400)
            .send({ error: "Bad Request", message: "invalid file path" });
        }
        request.log.error({ err, repositoryId: id }, "failed to read file");
        return reply.code(502).send({
          error: "Bad Gateway",
          message: "failed to read repository",
        });
      }
    },
  );
};
