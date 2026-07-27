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

import { strategyForCredential } from "../integrations/credentials.js";
import {
  DiscoveryError,
  PROVIDER_IDS,
  toDiscoveryError,
  type DiscoveryConnection,
  type ProviderId,
} from "../integrations/types.js";
import { orgIdOf } from "../rbac/request.js";
import {
  connectionsForProvider,
  discoverRepositories,
  resolveDiscoveryConnection,
} from "../services/repo-discovery.js";
import { detectRepositoryKind } from "../services/repo-kind-detect.js";

const providerParamsSchema = {
  type: "object",
  required: ["provider"],
  additionalProperties: false,
  properties: { provider: { type: "string", enum: [...PROVIDER_IDS] } },
};

/**
 * What the import screen asks about the page it is currently showing (GP-228).
 * A POST because it is a batch of targets, not an addressable resource: nothing
 * is created, and the answer is a pre-selection, never a decision.
 */
const detectSchema = {
  type: "object",
  required: ["repositories"],
  additionalProperties: false,
  properties: {
    credentialId: { type: "string", maxLength: 64 },
    repositories: {
      type: "array",
      minItems: 1,
      // One page of the import screen, not the whole installation: detection is
      // lazy on purpose (GP-228) — an org with 400 repositories must not fire
      // 400 tree calls because someone opened a screen.
      maxItems: 50,
      items: {
        type: "object",
        required: ["owner", "name"],
        additionalProperties: false,
        properties: {
          owner: { type: "string", minLength: 1, maxLength: 200 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          /** Omitted → the repository's default branch as discovery reported it. */
          ref: { type: "string", minLength: 1, maxLength: 200 },
          /** Detect inside a subdirectory rather than the whole repository. */
          path: { type: "string", maxLength: 500 },
        },
      },
    },
  },
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

  /**
   * What each of these repositories holds (GP-228) — a pre-selection for the
   * import screen, computed for the page in view and never for the whole
   * installation.
   *
   * A repository that could not be read comes back `kind: null`, like an
   * ambiguous one: the screen already knows how to ask, and one unreadable
   * repository must not blank the page.
   */
  app.post(
    "/integrations/:provider/repositories/detect",
    { schema: { params: providerParamsSchema, body: detectSchema } },
    async (request, reply) => {
      const { provider: providerId } = request.params as { provider: ProviderId };
      const body = request.body as {
        credentialId?: string;
        repositories: { owner: string; name: string; ref?: string; path?: string }[];
      };
      const orgId = orgIdOf(request);

      const trees = app.providers.get(providerId).trees;
      if (!trees) {
        return discoveryFailure(
          reply,
          new DiscoveryError(
            "unavailable",
            `${app.providers.get(providerId).label} cannot be inspected without cloning — choose the type yourself`,
          ),
        );
      }

      const connections = await connectionsForProvider(app, orgId, providerId);
      const resolved = resolveDiscoveryConnection({
        provider: providerId,
        ...(body.credentialId !== undefined
          ? { credentialId: body.credentialId }
          : {}),
        connections,
      });
      if (!resolved.ok) {
        return discoveryFailure(reply, resolved.error, {
          connections: resolved.candidates.map((row) => ({
            id: row.id,
            name: row.name,
          })),
        });
      }

      const connection: DiscoveryConnection = {
        credential: strategyForCredential(app, resolved.connection),
        config: resolved.connection.config,
      };

      const detections = await Promise.all(
        body.repositories.map(async (target) => {
          const detection = await detectRepositoryKind(app, {
            orgId,
            connection,
            trees,
            target: {
              owner: target.owner,
              name: target.name,
              ref: target.ref ?? "HEAD",
            },
            ...(target.path !== undefined ? { path: target.path } : {}),
          });
          return {
            fullName: `${target.owner}/${target.name}`,
            kind: detection.kind,
            confidence: detection.confidence,
            evidence: detection.evidence,
            suggestedPath: detection.suggestedPath,
            truncated: detection.truncated,
          };
        }),
      );

      return { detections };
    },
  );
};
