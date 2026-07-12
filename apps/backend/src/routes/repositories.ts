import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import { repositories, toPublicRepository, type RepositoryRow } from "../db/schema.js";
import { verifyAndStore } from "../services/repository-verification.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const updateRepositorySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    accessToken: { type: "string", minLength: 1, maxLength: 500 },
    defaultBranch: { type: "string", minLength: 1, maxLength: 200 },
    prCommentsEnabled: { type: "boolean" },
    // GP-60: long-form markdown context; editing it never re-verifies.
    contextMd: { type: ["string", "null"], maxLength: 50000 },
  },
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

export const repositoryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/repositories/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = await loadRepository(app, id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      return toPublicRepository(repo);
    },
  );

  // Update credentials (PAT) and/or default branch, then re-verify.
  app.patch(
    "/repositories/:id",
    { schema: { params: idParamsSchema, body: updateRepositorySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        accessToken?: string;
        defaultBranch?: string;
        prCommentsEnabled?: boolean;
        contextMd?: string | null;
      };

      const existing = await loadRepository(app, id);
      if (!existing) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const changingCredentials = body.accessToken !== undefined;
      const changingBranch = body.defaultBranch !== undefined;
      const [updated] = await app.db
        .update(repositories)
        .set({
          ...(changingCredentials
            ? { accessToken: app.encryptor.encrypt(body.accessToken as string) }
            : {}),
          ...(changingBranch ? { defaultBranch: body.defaultBranch } : {}),
          ...(body.prCommentsEnabled !== undefined
            ? { prCommentsEnabled: body.prCommentsEnabled }
            : {}),
          ...(body.contextMd !== undefined ? { contextMd: body.contextMd } : {}),
        })
        .where(eq(repositories.id, id))
        .returning();

      let row = updated ?? existing;
      // Re-verify only when credentials or the checked branch changed — toggling
      // a flag like PR comments should not trigger a network `git ls-remote`.
      if (changingCredentials || changingBranch) {
        row = (await verifyAndStore(app, row)).repository;
      }
      return toPublicRepository(row);
    },
  );

  // Manually check the connection with the stored credentials.
  app.post(
    "/repositories/:id/verify",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = await loadRepository(app, id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      const { result } = await verifyAndStore(app, repo);
      if (result.ok) {
        return { ok: true, default_branch_found: result.defaultBranchFound };
      }
      return { ok: false, error: result.error };
    },
  );

  app.delete(
    "/repositories/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(repositories)
        .where(eq(repositories.id, id))
        .returning({ id: repositories.id });
      if (deleted.length === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      return reply.code(204).send();
    },
  );
};
