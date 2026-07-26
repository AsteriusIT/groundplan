/**
 * Provider connections (GP-193): connect, list, revoke — and switch a repository
 * onto a connection.
 *
 * Every route here is **provider-agnostic**. It asks the registry what exists,
 * asks the provider for its flow, and stores whatever the flow returns. Adding
 * Azure DevOps or Confluence to this surface (GP-195..197) adds no route and no
 * branch: the catalog grows because the adapter declared a flow.
 *
 * Multi-tenancy is the org-scope plugin's (GP-114): these live under
 * `/api/v1/orgs/:orgId`, so a connection addressed from another org is a 404 and
 * an installation can only ever be bound to the org that completed its flow.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { and, asc, eq } from "drizzle-orm";

import {
  integrationCredentials,
  repositories,
  toPublicIntegrationCredential,
  type IntegrationCredentialRow,
} from "../db/schema.js";
import {
  InvalidConnectStateError,
  openConnectState,
  sealConnectState,
} from "../integrations/connect-state.js";
import { repositoriesUsingCredential } from "../integrations/credentials.js";
import {
  completeIntegrationOAuth,
  integrationTypeOf,
} from "../services/integration-connect.js";
import {
  CREDENTIAL_MODES,
  PROVIDER_IDS,
  type CredentialMode,
  type ProviderId,
} from "../integrations/types.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const startSchema = {
  type: "object",
  required: ["provider", "mode"],
  additionalProperties: false,
  properties: {
    provider: { type: "string", enum: [...PROVIDER_IDS] },
    mode: { type: "string", enum: [...CREDENTIAL_MODES] },
  },
};

const completeSchema = {
  type: "object",
  required: ["state", "params"],
  additionalProperties: false,
  properties: {
    state: { type: "string", minLength: 1, maxLength: 8000 },
    /** The provider's callback query, verbatim. Values are strings only. */
    params: {
      type: "object",
      additionalProperties: { type: "string", maxLength: 4000 },
    },
  },
};

const credentialSchema = {
  type: "object",
  required: ["credentialId"],
  additionalProperties: false,
  properties: {
    credentialId: { type: ["string", "null"], pattern: UUID_PATTERN },
  },
};

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: "Not Found", message });
}

function unprocessable(reply: FastifyReply, message: string) {
  return reply.code(422).send({ error: "Unprocessable Entity", message, fields: [] });
}

export const integrationConnectionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The catalog the UI renders (GP-198). Generated from the registry, so a new
   * adapter appears here — and therefore in the UI — with no frontend change.
   * `configured` is the honest per-instance answer: a deployment that registered
   * no GitHub App offers PAT only, and says so instead of showing a dead button.
   */
  app.get("/connections/providers", async () => {
    return app.providers.list().map((provider) => ({
      id: provider.id,
      label: provider.label,
      capabilities: provider.capabilities,
      credentialModes: provider.credentialModes,
      connectableModes: provider.connectFlows.map((flow) => flow.mode),
    }));
  });

  /** Every connection this org holds. Readable by any member; no secret leaves. */
  app.get("/connections", async (request) => {
    const rows = await app.db
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.organizationId, orgIdOf(request)))
      .orderBy(asc(integrationCredentials.createdAt));
    return rows.map(toPublicIntegrationCredential);
  });

  /**
   * Begin a connection: seal the org + mode + whatever the flow needs into an
   * opaque state, and hand back the URL to send the browser to.
   */
  app.post(
    "/connections/start",
    { schema: { body: startSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { provider: providerId, mode } = request.body as {
        provider: ProviderId;
        mode: CredentialMode;
      };
      const orgId = orgIdOf(request);

      const flow = app.providers.get(providerId).connectFlow(mode);
      if (!flow) {
        return unprocessable(
          reply,
          `${providerId} cannot be connected with ${mode} on this instance — it is not configured here`,
        );
      }
      if (!app.integrations.publicBaseUrl) {
        return unprocessable(
          reply,
          "this deployment has no public base URL configured, so a provider cannot redirect back to it",
        );
      }

      const redirectUri = `${app.integrations.publicBaseUrl}/integrations/callback`;
      const started = flow.start({ redirectUri });
      const state = sealConnectState(app.encryptor, {
        orgId,
        provider: providerId,
        mode,
        carry: started.carry,
      });
      return { authorizeUrl: started.authorizeUrl(state), redirectUri };
    },
  );

  /**
   * Finish a connection from the provider's callback — the **single sink** every
   * flow returns to, git provider or integration alike, because there is one
   * registered redirect URI and one callback page.
   *
   * The state proves which org started it, so a completion aimed at another
   * org's id cannot bind a grant there: the mismatch is a 404, like every
   * cross-tenant answer.
   */
  app.post(
    "/connections/complete",
    { schema: { body: completeSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { state, params } = request.body as {
        state: string;
        params: Record<string, string>;
      };
      const orgId = orgIdOf(request);

      let opened;
      try {
        opened = openConnectState(app.encryptor, state);
      } catch (err) {
        if (err instanceof InvalidConnectStateError) {
          return unprocessable(reply, err.message);
        }
        throw err;
      }
      if (opened.orgId !== orgId) {
        return notFound(reply, "this connection attempt does not belong to this organization");
      }

      // An Atlassian grant (GP-197) lands here too and is stored as an org
      // Integration, beside the credential it replaces.
      if (integrationTypeOf(opened)) {
        const result = await completeIntegrationOAuth(app, orgId, opened, params);
        if (!result.ok) return unprocessable(reply, result.message);
        return reply
          .code(result.created ? 201 : 200)
          .send(result.integration);
      }

      const flow = app.providers.get(opened.provider).connectFlow(opened.mode);
      if (!flow) {
        return unprocessable(
          reply,
          `${opened.provider} cannot be connected with ${opened.mode} on this instance`,
        );
      }

      let connection;
      try {
        connection = await flow.complete({
          params,
          carry: opened.carry,
          redirectUri: `${app.integrations.publicBaseUrl}/integrations/callback`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.warn({ err, provider: opened.provider }, "connect flow failed");
        return unprocessable(reply, message);
      }

      // One connection per (org, provider, target): reconnecting replaces the
      // credential in place, which keeps every repository pointing at it working
      // instead of leaving a dead row and a fresh one beside it.
      const existing = await findExisting(opened.provider, orgId, connection.config);
      const values = {
        organizationId: orgId,
        provider: opened.provider,
        mode: opened.mode,
        name: connection.name,
        config: connection.config,
        secret: connection.secret ? app.encryptor.encrypt(connection.secret) : null,
        status: "ok" as const,
        lastError: null,
        updatedAt: new Date(),
      };

      const [row] = existing
        ? await app.db
            .update(integrationCredentials)
            .set(values)
            .where(eq(integrationCredentials.id, existing.id))
            .returning()
        : await app.db.insert(integrationCredentials).values(values).returning();

      return reply
        .code(existing ? 200 : 201)
        .send(toPublicIntegrationCredential(row!));
    },
  );

  /** Which connection, if any, this org already holds for the same target. */
  async function findExisting(
    provider: ProviderId,
    orgId: string,
    config: { installationId?: number; instanceUrl?: string | null; cloudId?: string | null },
  ): Promise<IntegrationCredentialRow | undefined> {
    const rows = await app.db
      .select()
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.organizationId, orgId),
          eq(integrationCredentials.provider, provider),
        ),
      );
    return rows.find(
      (row) =>
        (config.installationId !== undefined &&
          row.config.installationId === config.installationId) ||
        (config.cloudId != null && row.config.cloudId === config.cloudId) ||
        (config.instanceUrl != null && row.config.instanceUrl === config.instanceUrl),
    );
  }

  /**
   * What revoking would cost, before it is done (GP-198): the repositories that
   * would fall back to their own PAT — or to nothing.
   */
  app.get(
    "/connections/:id/impact",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const connection = await loadConnection(orgIdOf(request), id);
      if (!connection) return notFound(reply, "connection not found");
      const affected = await repositoriesUsingCredential(app, id);
      return { repositories: affected };
    },
  );

  /**
   * Revoke a connection. Repositories that used it are *not* deleted: the FK is
   * `set null`, so each falls back to its own PAT if it has one and reports "no
   * credential" if it does not. Honest degradation beats a cascade.
   */
  app.delete(
    "/connections/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { id } = request.params as { id: string };
      const connection = await loadConnection(orgIdOf(request), id);
      if (!connection) return notFound(reply, "connection not found");
      await app.db
        .delete(integrationCredentials)
        .where(eq(integrationCredentials.id, id));
      return reply.code(204).send();
    },
  );

  async function loadConnection(
    orgId: string,
    id: string,
  ): Promise<IntegrationCredentialRow | undefined> {
    const [row] = await app.db
      .select()
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.id, id),
          eq(integrationCredentials.organizationId, orgId),
        ),
      );
    return row;
  }

  /**
   * Switch one repository onto a connection, or back to its own PAT (`null`).
   * Nothing else changes: the PAT column is left alone, so the move is
   * reversible, and pull requests, docs and annotations are untouched — they
   * hang off the repository, not off how it authenticates.
   */
  app.put(
    "/repositories/:id/credential",
    { schema: { params: idParamsSchema, body: credentialSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "integration:manage")) return reply;
      const { id } = request.params as { id: string };
      const { credentialId } = request.body as { credentialId: string | null };
      const orgId = orgIdOf(request);

      const [repo] = await app.db
        .select()
        .from(repositories)
        .where(eq(repositories.id, id));
      if (!repo) return notFound(reply, "repository not found");

      let mode: CredentialMode | null = null;
      if (credentialId) {
        const connection = await loadConnection(orgId, credentialId);
        if (!connection) return notFound(reply, "connection not found");
        if (connection.provider !== repo.provider) {
          return unprocessable(
            reply,
            `this connection is for ${connection.provider}; the repository is ${repo.provider}`,
          );
        }
        mode = connection.mode;
      }

      const [updated] = await app.db
        .update(repositories)
        .set({ credentialId })
        .where(eq(repositories.id, id))
        .returning();

      return { id: updated!.id, credentialId: updated!.credentialId, authMode: mode };
    },
  );
};
