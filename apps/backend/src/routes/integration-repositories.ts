/**
 * Discovery (GP-227): the repositories an org's connection can reach.
 *
 * `GET /api/v1/orgs/:orgId/integrations/:provider/repositories`
 *
 * Provider-agnostic at the route level, like every connection route: it asks the
 * registry for the provider, asks the provider for its discoverer, and 422s with
 * a typed code when there is none. Adding GitLab discovery adds an adapter, not
 * a route.
 *
 * A failure here is never an empty list. "Your installation was revoked" and
 * "your installation covers nothing" are different facts, and an onboarding
 * screen that confuses them sends the user looking in the wrong place.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import {
  DiscoveryError,
  PROVIDER_IDS,
  toDiscoveryError,
  type ProviderId,
} from "../integrations/types.js";
import { orgIdOf } from "../rbac/request.js";
import {
  connectionsForProvider,
  discoverRepositories,
  resolveDiscoveryConnection,
} from "../services/repo-discovery.js";

const providerParamsSchema = {
  type: "object",
  required: ["provider"],
  additionalProperties: false,
  properties: { provider: { type: "string", enum: [...PROVIDER_IDS] } },
};

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    /** Our own opaque bookmark — never a provider URL. */
    cursor: { type: "string", maxLength: 200 },
    /** Server-side filter on `owner/name`, over the whole scope. */
    search: { type: "string", maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    /** Which connection to list, when the org holds more than one. */
    credentialId: { type: "string", maxLength: 64 },
  },
};

/**
 * A typed discovery refusal. 422 rather than 500: nothing is broken on our side,
 * the answer is simply one the user has to act on, and `code` is what the UI
 * switches its remediation on.
 */
function discoveryFailure(
  reply: FastifyReply,
  error: DiscoveryError,
  extra: Record<string, unknown> = {},
) {
  return reply.code(422).send({
    error: "Unprocessable Entity",
    message: error.message,
    code: error.code,
    ...extra,
  });
}

export const integrationRepositoryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/integrations/:provider/repositories",
    { schema: { params: providerParamsSchema, querystring: querySchema } },
    async (request, reply) => {
      const { provider: providerId } = request.params as { provider: ProviderId };
      const query = request.query as {
        cursor?: string;
        search?: string;
        limit?: number;
        credentialId?: string;
      };
      const orgId = orgIdOf(request);

      const discoverer = app.providers.get(providerId).discoverer;
      if (!discoverer) {
        return discoveryFailure(
          reply,
          new DiscoveryError(
            "installation_not_linked",
            `${app.providers.get(providerId).label} cannot list repositories on this instance — attach them by URL instead`,
          ),
        );
      }

      const connections = await connectionsForProvider(app, orgId, providerId);
      const resolved = resolveDiscoveryConnection({
        provider: providerId,
        credentialId: query.credentialId,
        connections,
      });
      if (!resolved.ok) {
        return discoveryFailure(reply, resolved.error, {
          // The UI renders a picker from these; it never guesses an id.
          connections: resolved.candidates.map((row) => ({
            id: row.id,
            name: row.name,
          })),
        });
      }

      try {
        const page = await discoverRepositories(app, {
          orgId,
          connection: resolved.connection,
          discoverer,
          ...(query.search !== undefined ? { search: query.search } : {}),
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        });
        return { credentialId: resolved.connection.id, ...page };
      } catch (err) {
        const failure = toDiscoveryError(err);
        app.log.warn(
          { err, provider: providerId, credentialId: resolved.connection.id },
          "repository discovery failed",
        );
        return discoveryFailure(reply, failure);
      }
    },
  );
};
