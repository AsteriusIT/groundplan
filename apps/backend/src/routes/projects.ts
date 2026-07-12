import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";

import { projects, repositories, toPublicRepository } from "../db/schema.js";
import { generateToken } from "../lib/tokens.js";
import { detectProvider, PROVIDERS, type Provider } from "../services/providers.js";
import { verifyAndStore } from "../services/repository-verification.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const createProjectSchema = {
  type: "object",
  required: ["name", "slug"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    slug: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    },
  },
};

const createRepositorySchema = {
  type: "object",
  required: ["url"],
  additionalProperties: false,
  properties: {
    // Optional (GP-51): omitted -> auto-detected from the URL. An explicit value
    // is an override and wins over detection.
    provider: { type: "string", enum: [...PROVIDERS] },
    url: { type: "string", minLength: 1, maxLength: 500 },
    defaultBranch: { type: "string", minLength: 1, maxLength: 200 },
    // Write-only: accepted here, never echoed back in any response.
    accessToken: { type: "string", minLength: 1, maxLength: 500 },
  },
};

// Postgres unique-violation SQLSTATE. Drizzle wraps the driver error, so the
// original pg error (which carries `code`) can be nested under `.cause`.
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: string }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get("/projects", async () => {
    return app.db.select().from(projects).orderBy(desc(projects.createdAt));
  });

  app.post(
    "/projects",
    { schema: { body: createProjectSchema } },
    async (request, reply) => {
      const { name, slug } = request.body as { name: string; slug: string };
      try {
        const [row] = await app.db
          .insert(projects)
          .values({ name, slug })
          .returning();
        return reply.code(201).send(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply
            .code(409)
            .send({ error: "Conflict", message: `slug '${slug}' already exists` });
        }
        throw err;
      }
    },
  );

  app.get(
    "/projects/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [row] = await app.db
        .select()
        .from(projects)
        .where(eq(projects.id, id));
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "project not found" });
      }
      return row;
    },
  );

  app.delete(
    "/projects/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning({ id: projects.id });
      if (deleted.length === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "project not found" });
      }
      return reply.code(204).send();
    },
  );

  app.get(
    "/projects/:id/repositories",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id));
      if (!project) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "project not found" });
      }
      const rows = await app.db
        .select()
        .from(repositories)
        .where(eq(repositories.projectId, id))
        .orderBy(desc(repositories.createdAt));
      return rows.map(toPublicRepository);
    },
  );

  app.post(
    "/projects/:id/repositories",
    { schema: { params: idParamsSchema, body: createRepositorySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        provider?: Provider;
        url: string;
        defaultBranch?: string;
        accessToken?: string;
      };

      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id));
      if (!project) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "project not found" });
      }

      // Provider override wins; otherwise auto-detect from the URL (GP-51).
      const provider = body.provider ?? detectProvider(body.url);

      // PAT is stored ENCRYPTED at rest, never in plaintext.
      const encryptedPat = body.accessToken
        ? app.encryptor.encrypt(body.accessToken)
        : null;

      const [inserted] = await app.db
        .insert(repositories)
        .values({
          projectId: id,
          provider,
          url: body.url,
          // Omitted -> DB default ("main").
          defaultBranch: body.defaultBranch,
          accessToken: encryptedPat,
          webhookToken: generateToken(),
        })
        .returning();

      // Auto-verify the connection when credentials were supplied.
      let row = inserted!;
      if (encryptedPat) {
        row = (await verifyAndStore(app, row)).repository;
      }

      // webhook_token is shown ONCE here; PAT is masked; excluded from lists.
      return reply.code(201).send({
        ...toPublicRepository(row),
        webhookToken: row.webhookToken,
      });
    },
  );
};
