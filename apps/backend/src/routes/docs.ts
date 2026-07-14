import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";

import {
  graphSnapshots,
  repositories,
  type RepositoryRow,
} from "../db/schema.js";
import {
  DocsGenerationInProgressError,
  generateDocsSnapshot,
} from "../services/repo-docs.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

async function loadRepository(
  app: FastifyInstance,
  id: string,
): Promise<RepositoryRow | undefined> {
  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id));
  return repo;
}

export const docsRoutes: FastifyPluginAsync = async (app) => {
  // Generate documentation of the default branch (Producer B). Synchronous:
  // clone → static HCL parse → store snapshot. 409 if one is already running.
  app.post(
    "/repositories/:id/docs/generate",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = await loadRepository(app, id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      // GP-101: this producer parses HCL. A kubernetes repository is told so
      // plainly — a silently empty diagram is the one answer nobody can act on.
      // (GP-102 gives it a producer of its own and this becomes a branch.)
      if (repo.iacType !== "terraform") {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message:
            "this repository holds kubernetes manifests — Terraform documentation does not apply to it",
        });
      }

      try {
        const snapshot = await generateDocsSnapshot(app, repo);
        return reply.code(201).send({ id: snapshot.id });
      } catch (err) {
        if (err instanceof DocsGenerationInProgressError) {
          return reply.code(409).send({ error: "Conflict", message: err.message });
        }
        throw err;
      }
    },
  );

  // The latest docs (source=hcl) snapshot, including its graph.
  app.get(
    "/repositories/:id/docs/latest",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = await loadRepository(app, id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const [row] = await app.db
        .select()
        .from(graphSnapshots)
        .where(
          and(
            eq(graphSnapshots.repositoryId, id),
            eq(graphSnapshots.source, "hcl"),
          ),
        )
        .orderBy(desc(graphSnapshots.createdAt))
        .limit(1);

      if (!row) {
        return reply.code(404).send({
          error: "Not Found",
          message: "no documentation snapshot yet",
        });
      }
      return row;
    },
  );
};
