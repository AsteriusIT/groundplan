import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";

import {
  confluenceConnections,
  integrations,
  repositories,
  toPublicConfluenceConnection,
  type ConfluenceConnectionRow,
} from "../db/schema.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";
import {
  latestDocsSnapshot,
  publishDocsSnapshot,
} from "../services/confluence-publish.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

// The repo target no longer carries a credential (GP-183): it names an org
// Integration and the space its docs publish to. Both required.
const upsertSchema = {
  type: "object",
  required: ["integrationId", "spaceKey"],
  additionalProperties: false,
  properties: {
    integrationId: { type: "string", pattern: UUID_PATTERN },
    spaceKey: { type: "string", minLength: 1, maxLength: 255 },
  },
};

type UpsertBody = {
  integrationId: string;
  spaceKey: string;
};

async function repositoryExists(app: FastifyInstance, id: string): Promise<boolean> {
  const [row] = await app.db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.id, id));
  return row !== undefined;
}

async function loadConnection(
  app: FastifyInstance,
  repositoryId: string,
): Promise<ConfluenceConnectionRow | undefined> {
  const [row] = await app.db
    .select()
    .from(confluenceConnections)
    .where(eq(confluenceConnections.repositoryId, repositoryId));
  return row;
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: "Not Found", message });
}

/**
 * A repository's Confluence publish target (GP-179; re-homed by GP-183): which
 * org Integration authenticates the publish (GP-180) and which space its docs
 * land in. One per repository, addressed as a child of the repository (so the
 * org-scope guard proves ownership on the parent id). The credential lives on
 * the org Integration now — this endpoint never sees one.
 */
export const confluenceRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/repositories/:id/confluence",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await repositoryExists(app, id))) {
        return notFound(reply, "repository not found");
      }
      const connection = await loadConnection(app, id);
      if (!connection) {
        return notFound(reply, "confluence target not configured");
      }
      return toPublicConfluenceConnection(connection);
    },
  );

  // Create-or-replace: the target is one config record, so PUT is its natural
  // verb — a second save is an edit, not a second target.
  app.put(
    "/repositories/:id/confluence",
    { schema: { params: idParamsSchema, body: upsertSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const body = request.body as UpsertBody;
      if (!(await repositoryExists(app, id))) {
        return notFound(reply, "repository not found");
      }

      // The chosen integration must belong to this repo's org — a cross-org id
      // is a 404, never a usable target (the guard proved the repo is in-org).
      const [integration] = await app.db
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(
            eq(integrations.id, body.integrationId),
            eq(integrations.organizationId, orgIdOf(request)),
          ),
        );
      if (!integration) {
        return notFound(reply, "integration not found");
      }

      const values = {
        integrationId: body.integrationId,
        spaceKey: body.spaceKey,
      };

      const existing = await loadConnection(app, id);
      let row: ConfluenceConnectionRow | undefined;
      if (existing) {
        [row] = await app.db
          .update(confluenceConnections)
          .set(values)
          .where(eq(confluenceConnections.id, existing.id))
          .returning();
      } else {
        [row] = await app.db
          .insert(confluenceConnections)
          .values({ ...values, repositoryId: id })
          .returning();
      }

      return reply
        .code(existing ? 200 : 201)
        .send(toPublicConfluenceConnection(row!));
    },
  );

  // Publish the latest docs snapshot to the configured page (GP-180).
  // Member-level on purpose, like docs generation (GP-23): publishing the
  // team's own docs page is a docs action — and auto-publish already runs with
  // no user at all on merge. Managing the *integration* is what needs admin.
  app.post(
    "/repositories/:id/confluence/publish",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [repo] = await app.db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id));
      if (!repo) return notFound(reply, "repository not found");
      const connection = await loadConnection(app, id);
      if (!connection) {
        return notFound(reply, "confluence target not configured");
      }
      const snapshot = await latestDocsSnapshot(app, repo);
      if (!snapshot) {
        return notFound(
          reply,
          "no docs snapshot to publish — generate documentation first",
        );
      }
      const result = await publishDocsSnapshot(app, repo, connection, snapshot);
      if (result.ok) {
        return {
          ok: true,
          pageUrl: result.pageUrl,
          publishedAt: result.publishedAt,
        };
      }
      return { ok: false, error: result.error };
    },
  );

  app.delete(
    "/repositories/:id/confluence",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(confluenceConnections)
        .where(eq(confluenceConnections.repositoryId, id))
        .returning({ id: confluenceConnections.id });
      if (deleted.length === 0) {
        return notFound(reply, "confluence target not configured");
      }
      return reply.code(204).send();
    },
  );
};
