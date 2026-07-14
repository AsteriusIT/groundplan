import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, inArray, max } from "drizzle-orm";

import {
  graphSnapshots,
  ingestionEvents,
  projects,
  pullRequests,
  repositories,
  repositoryIacType,
  toPublicRepository,
} from "../db/schema.js";
import { InvalidRepoPathError, normalizeTerraformPath } from "../lib/repo-path.js";
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

// GP-60: a sane cap for the long-form markdown context on projects/repos.
const CONTEXT_MAX = 50000;

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
    contextMd: { type: ["string", "null"], maxLength: CONTEXT_MAX },
  },
};

const updateProjectSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    contextMd: { type: ["string", "null"], maxLength: CONTEXT_MAX },
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
    // What the repository holds (GP-101). Omitted -> terraform, so every caller
    // written before Kubernetes existed keeps working unchanged. Set once: there
    // is no PATCH for it (GP-100 — a repo is one kind, not both).
    iacType: { type: "string", enum: [...repositoryIacType.enumValues] },
    // Write-only: accepted here, never echoed back in any response.
    accessToken: { type: "string", minLength: 1, maxLength: 500 },
    // Subdirectory the IaC lives in; omitted/"" is the repository root. Shape is
    // checked here, meaning (no escaping the repo) in normalizeTerraformPath.
    terraformPath: { type: "string", maxLength: 500 },
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
      const { name, slug, contextMd } = request.body as {
        name: string;
        slug: string;
        contextMd?: string | null;
      };
      try {
        const [row] = await app.db
          .insert(projects)
          .values({ name, slug, contextMd: contextMd ?? null })
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

  // Update a project's name and/or its long-form context (GP-60).
  app.patch(
    "/projects/:id",
    { schema: { params: idParamsSchema, body: updateProjectSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; contextMd?: string | null };
      const [updated] = await app.db
        .update(projects)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.contextMd !== undefined ? { contextMd: body.contextMd } : {}),
        })
        .where(eq(projects.id, id))
        .returning();
      if (!updated) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "project not found" });
      }
      return updated;
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

  /**
   * Activity signal for every repository in the project, in one call — what the
   * project page needs to answer "is my CI actually sending data?" without
   * clicking into each repo. Aggregates only (three grouped counts/maxima); it
   * never loads a snapshot graph or an event payload.
   *
   * Every repository gets a row, zeroed when nothing has arrived yet: a missing
   * row and a quiet repo mean different things to the caller.
   */
  app.get(
    "/projects/:id/repositories/activity",
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
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.projectId, id));
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return [];

      const [openPrs, snapshots, events] = await Promise.all([
        app.db
          .select({ repositoryId: pullRequests.repositoryId, n: count() })
          .from(pullRequests)
          .where(
            and(
              inArray(pullRequests.repositoryId, ids),
              eq(pullRequests.state, "open"),
            ),
          )
          .groupBy(pullRequests.repositoryId),
        app.db
          .select({
            repositoryId: graphSnapshots.repositoryId,
            at: max(graphSnapshots.createdAt),
          })
          .from(graphSnapshots)
          .where(inArray(graphSnapshots.repositoryId, ids))
          .groupBy(graphSnapshots.repositoryId),
        app.db
          .select({
            repositoryId: ingestionEvents.repositoryId,
            at: max(ingestionEvents.receivedAt),
          })
          .from(ingestionEvents)
          .where(inArray(ingestionEvents.repositoryId, ids))
          .groupBy(ingestionEvents.repositoryId),
      ]);

      const prCounts = new Map(openPrs.map((r) => [r.repositoryId, r.n]));
      const lastSnapshot = new Map(snapshots.map((r) => [r.repositoryId, r.at]));
      const lastEvent = new Map(events.map((r) => [r.repositoryId, r.at]));

      return ids.map((repositoryId) => ({
        repositoryId,
        openPrs: prCounts.get(repositoryId) ?? 0,
        lastSnapshotAt: lastSnapshot.get(repositoryId) ?? null,
        lastEventAt: lastEvent.get(repositoryId) ?? null,
      }));
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
        iacType?: (typeof repositoryIacType.enumValues)[number];
        accessToken?: string;
        terraformPath?: string;
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

      let terraformPath: string;
      try {
        terraformPath = normalizeTerraformPath(body.terraformPath);
      } catch (err) {
        if (err instanceof InvalidRepoPathError) {
          return reply.code(422).send({
            error: "Unprocessable Entity",
            message: err.message,
            fields: [{ field: "terraformPath", message: err.message }],
          });
        }
        throw err;
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
          // Omitted -> DB default ("terraform"): the kind every repo was before.
          iacType: body.iacType,
          url: body.url,
          // Omitted -> DB default ("main").
          defaultBranch: body.defaultBranch,
          accessToken: encryptedPat,
          terraformPath,
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
