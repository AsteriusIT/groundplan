import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";

import {
  confluenceConnections,
  repositories,
  toPublicConfluenceConnection,
  type ConfluenceConnectionRow,
} from "../db/schema.js";
import { requirePermission } from "../rbac/request.js";
import type { ConfluenceAuthType } from "../services/confluence.js";
import { verifyConfluenceAndStore } from "../services/confluence-verification.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

// https only — a Basic/Bearer credential over cleartext is a credential in a
// packet capture. (The client itself is scheme-agnostic so its tests can run
// against a local http server; the API boundary is where the rule lives.)
const upsertSchema = {
  type: "object",
  required: ["baseUrl", "spaceKey", "authType"],
  additionalProperties: false,
  properties: {
    baseUrl: { type: "string", pattern: "^https://", maxLength: 2000 },
    spaceKey: { type: "string", minLength: 1, maxLength: 255 },
    authType: { type: "string", enum: ["cloud_token", "dc_pat"] },
    email: { type: "string", minLength: 3, maxLength: 320 },
    // Write-only: accepted here, never echoed back in any response. Optional on
    // update — blank means "keep the stored one", the repository-PAT rule.
    credential: { type: "string", minLength: 1, maxLength: 8000 },
  },
};

type UpsertBody = {
  baseUrl: string;
  spaceKey: string;
  authType: ConfluenceAuthType;
  email?: string;
  credential?: string;
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

function unprocessable(reply: FastifyReply, field: string, message: string) {
  return reply.code(422).send({
    error: "Unprocessable Entity",
    message,
    fields: [{ field, message }],
  });
}

/**
 * A repository's Confluence connection (GP-179): where GP-180 publishes its
 * docs page. One per repository, addressed as a child of the repository (so the
 * org-scope guard proves ownership on the parent id). The credential follows
 * the repository-PAT rules — encrypted at rest, write-only, verified on save.
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
        return notFound(reply, "confluence connection not configured");
      }
      return toPublicConfluenceConnection(connection);
    },
  );

  // Create-or-replace: the connection is one config record, so PUT is its
  // natural verb — a second save is an edit, not a second connection.
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

      if (body.authType === "cloud_token" && !body.email?.trim()) {
        return unprocessable(
          reply,
          "email",
          "a Confluence Cloud API token authenticates as Basic email:token — the account email is required",
        );
      }

      const existing = await loadConnection(app, id);
      if (!existing && !body.credential) {
        return unprocessable(reply, "credential", "a credential is required");
      }

      const values = {
        baseUrl: body.baseUrl.replace(/\/+$/, ""),
        spaceKey: body.spaceKey,
        authType: body.authType,
        email: body.authType === "cloud_token" ? (body.email ?? null) : null,
        ...(body.credential
          ? { credential: app.encryptor.encrypt(body.credential) }
          : {}),
      };

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
          .values({ ...values, repositoryId: id, credential: values.credential! })
          .returning();
      }

      // Saving a target is a claim we can publish to it — so we check, at once
      // (the repository rule, GP-11). An unreachable target is still stored,
      // and says so.
      const { connection } = await verifyConfluenceAndStore(app, row!);
      return reply
        .code(existing ? 200 : 201)
        .send(toPublicConfluenceConnection(connection));
    },
  );

  // Check the connection with the stored credential, on demand.
  app.post(
    "/repositories/:id/confluence/verify",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const connection = await loadConnection(app, id);
      if (!connection) {
        return notFound(reply, "confluence connection not configured");
      }
      const { result } = await verifyConfluenceAndStore(app, connection);
      if (result.ok) return { ok: true };
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
        return notFound(reply, "confluence connection not configured");
      }
      return reply.code(204).send();
    },
  );
};
