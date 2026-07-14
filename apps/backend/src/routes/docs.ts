import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { and, desc, eq } from "drizzle-orm";

import {
  graphSnapshots,
  repositories,
  type RepositoryRow,
} from "../db/schema.js";
import { docsSourceFor } from "../services/graph-snapshots.js";
import {
  DocsGenerationInProgressError,
  NoManifestsError,
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
  // clone → static parse (HCL, or YAML manifests for a kubernetes repository —
  // GP-102) → store snapshot. 409 if one is already running.
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

      try {
        const snapshot = await generateDocsSnapshot(app, repo);
        return reply.code(201).send({ id: snapshot.id });
      } catch (err) {
        if (err instanceof DocsGenerationInProgressError) {
          return reply.code(409).send({ error: "Conflict", message: err.message });
        }
        // Nothing to draw, and a reason the user can act on (a templated chart is
        // rendered by their CI, not by us). We store nothing rather than an empty
        // diagram nobody could tell from a broken one.
        if (err instanceof NoManifestsError) {
          return reply.code(422).send({
            error: "Unprocessable Entity",
            message: err.message,
            warnings: err.warnings,
          });
        }
        throw err;
      }
    },
  );

  // The latest docs snapshot (whichever producer documents this repository),
  // including its graph.
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
            eq(graphSnapshots.source, docsSourceFor(repo.iacType)),
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
