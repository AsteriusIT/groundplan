import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { and, asc, eq } from "drizzle-orm";

import {
  confluenceConnections,
  integrations,
  toPublicIntegration,
  type IntegrationConfig,
  type IntegrationRow,
} from "../db/schema.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";
import {
  trimTrailingSlashes,
  type ConfluenceAuthType,
} from "../services/confluence.js";
import { verifyIntegrationAndStore } from "../services/integration-verification.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

// https only — a Basic/Bearer credential over cleartext is a credential in a
// packet capture (mirrors the repo Confluence rule, GP-179).
const createSchema = {
  type: "object",
  required: ["type", "name", "baseUrl", "authType", "credential"],
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["atlassian"] },
    name: { type: "string", minLength: 1, maxLength: 255 },
    baseUrl: { type: "string", pattern: "^https://", maxLength: 2000 },
    authType: { type: "string", enum: ["cloud_token", "dc_pat"] },
    email: { type: "string", minLength: 3, maxLength: 320 },
    credential: { type: "string", minLength: 1, maxLength: 8000 },
  },
};

// Edit: everything optional (a partial update). A blank credential keeps the
// stored one — the PAT rule, so a rename never re-enters a token.
const patchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255 },
    baseUrl: { type: "string", pattern: "^https://", maxLength: 2000 },
    authType: { type: "string", enum: ["cloud_token", "dc_pat"] },
    email: { type: "string", minLength: 3, maxLength: 320 },
    credential: { type: "string", minLength: 1, maxLength: 8000 },
  },
};

type CreateBody = {
  type: "atlassian";
  name: string;
  baseUrl: string;
  authType: ConfluenceAuthType;
  email?: string;
  credential: string;
};

type PatchBody = {
  name?: string;
  baseUrl?: string;
  authType?: ConfluenceAuthType;
  email?: string;
  credential?: string;
};

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

async function loadIntegration(
  app: FastifyInstance,
  orgId: string,
  id: string,
): Promise<IntegrationRow | undefined> {
  const [row] = await app.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.organizationId, orgId)));
  return row;
}

/**
 * Organization-level Integrations (GP-183): an external credential configured
 * once per org and attached by N repositories. The one type today is `atlassian`
 * (Confluence). Managing an integration (create/edit/verify/delete) needs
 * `integration:manage` (owner/admin); any member may read the list to pick one
 * at repo level. The org-scope guard proves the addressed integration belongs to
 * `:orgId` (a cross-tenant id is a 404), and the credential is write-only —
 * encrypted at rest, masked as "***" on the way out.
 */
export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // Any member reads the list — name + status only, credential masked.
  app.get("/integrations", async (request) => {
    const orgId = orgIdOf(request);
    const rows = await app.db
      .select()
      .from(integrations)
      .where(eq(integrations.organizationId, orgId))
      .orderBy(asc(integrations.createdAt));
    return rows.map(toPublicIntegration);
  });

  app.get(
    "/integrations/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const integration = await loadIntegration(app, orgIdOf(request), id);
      if (!integration) return notFound(reply, "integration not found");
      return toPublicIntegration(integration);
    },
  );

  app.post(
    "/integrations",
    { schema: { body: createSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const body = request.body as CreateBody;

      if (body.authType === "cloud_token" && !body.email?.trim()) {
        return unprocessable(
          reply,
          "email",
          "a Confluence Cloud API token authenticates as Basic email:token — the account email is required",
        );
      }

      const config: IntegrationConfig = {
        baseUrl: trimTrailingSlashes(body.baseUrl),
        authType: body.authType,
        email: body.authType === "cloud_token" ? (body.email ?? null) : null,
      };

      const [row] = await app.db
        .insert(integrations)
        .values({
          organizationId: orgIdOf(request),
          type: body.type,
          name: body.name,
          config,
          credential: app.encryptor.encrypt(body.credential),
        })
        .returning();

      // Saving a credential is a claim we can reach the instance — so we check,
      // at once (the repository rule, GP-11). An unreachable target is still
      // stored, and says so.
      const { integration } = await verifyIntegrationAndStore(app, row!);
      return reply.code(201).send(toPublicIntegration(integration));
    },
  );

  app.patch(
    "/integrations/:id",
    { schema: { params: idParamsSchema, body: patchSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { id } = request.params as { id: string };
      const body = request.body as PatchBody;
      const orgId = orgIdOf(request);
      const existing = await loadIntegration(app, orgId, id);
      if (!existing) return notFound(reply, "integration not found");

      const authType = body.authType ?? existing.config.authType;
      // The email that will authenticate after this edit: an incoming one, else
      // the stored one — but only Cloud tokens carry an email at all.
      const email =
        authType === "cloud_token"
          ? (body.email?.trim() ?? existing.config.email)
          : null;
      if (authType === "cloud_token" && !email) {
        return unprocessable(
          reply,
          "email",
          "a Confluence Cloud API token authenticates as Basic email:token — the account email is required",
        );
      }

      const config: IntegrationConfig = {
        baseUrl: body.baseUrl ? trimTrailingSlashes(body.baseUrl) : existing.config.baseUrl,
        authType,
        email,
      };

      const [row] = await app.db
        .update(integrations)
        .set({
          ...(body.name ? { name: body.name } : {}),
          config,
          ...(body.credential
            ? { credential: app.encryptor.encrypt(body.credential) }
            : {}),
        })
        .where(eq(integrations.id, existing.id))
        .returning();

      const { integration } = await verifyIntegrationAndStore(app, row!);
      return toPublicIntegration(integration);
    },
  );

  // Check the integration with its stored credential, on demand.
  app.post(
    "/integrations/:id/verify",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { id } = request.params as { id: string };
      const integration = await loadIntegration(app, orgIdOf(request), id);
      if (!integration) return notFound(reply, "integration not found");
      const { result } = await verifyIntegrationAndStore(app, integration);
      if (result.ok) return { ok: true };
      return { ok: false, error: result.error };
    },
  );

  app.delete(
    "/integrations/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { id } = request.params as { id: string };
      const integration = await loadIntegration(app, orgIdOf(request), id);
      if (!integration) return notFound(reply, "integration not found");

      // Blocked while a repository target still points at it (the FK is the DB
      // backstop; this is the friendly explanation).
      const [ref] = await app.db
        .select({ id: confluenceConnections.id })
        .from(confluenceConnections)
        .where(eq(confluenceConnections.integrationId, id))
        .limit(1);
      if (ref) {
        return reply.code(409).send({
          error: "Conflict",
          message:
            "this integration is used by one or more repositories — remove those Confluence targets first",
        });
      }

      await app.db.delete(integrations).where(eq(integrations.id, id));
      return reply.code(204).send();
    },
  );
};
