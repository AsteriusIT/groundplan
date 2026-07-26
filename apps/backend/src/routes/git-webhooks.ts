/**
 * Git provider webhooks (GP-194): `POST /api/v1/webhooks/git/:provider`.
 *
 * One endpoint for every provider, because the differences — how a delivery is
 * signed, what its JSON looks like — are exactly what the adapters own. This
 * route does the parts that are the same everywhere: bound the payload, find the
 * repository the event is about, verify the sender, and hand the normalized
 * events to the shared handler.
 *
 * It is **auth-exempt**, like the CI ingestion webhook: a provider has no
 * bearer token. It authenticates by proving it knows a secret, so a delivery
 * that fails verification is 401 and nothing else happens.
 *
 * Self-hosting with no inbound webhooks stays exactly as it was: nobody calls
 * this, `webhook_seen_at` stays null, and the poller remains the only source.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";

import { repositories, type RepositoryRow } from "../db/schema.js";
import { PROVIDER_IDS, type ProviderId, type RawWebhook } from "../integrations/types.js";
import { handleRefEvent, markWebhookSeen } from "../services/ref-events.js";

/** 2 MB — a push payload with a very large commit list, and no more. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const paramsSchema = {
  type: "object",
  required: ["provider"],
  additionalProperties: false,
  properties: { provider: { type: "string", enum: [...PROVIDER_IDS] } },
};

/**
 * Compare two repository URLs the way a human would: same host, same path,
 * ignoring `.git`, a trailing slash, case and any embedded credentials. A
 * provider names its repository in several forms across payloads (`clone_url`,
 * `html_url`, `remoteUrl`) and none of them is guaranteed to be byte-identical
 * to what the user typed when they attached it.
 */
export function sameRepository(a: string, b: string): boolean {
  const key = (raw: string): string | null => {
    try {
      const u = new URL(raw);
      const path = u.pathname.replace(/\.git$/, "").replace(/(?=(\/+))\1$/, "");
      return `${u.hostname.toLowerCase()}${path.toLowerCase()}`;
    } catch {
      return null;
    }
  };
  const ka = key(a);
  const kb = key(b);
  return ka !== null && ka === kb;
}

/**
 * The repositories an event is about. A URL can legitimately be attached more
 * than once (a monorepo holding Terraform *and* manifests, GP-101), so this
 * returns every match and each is handled independently.
 */
async function repositoriesFor(
  app: FastifyInstance,
  provider: ProviderId,
  remoteUrl: string,
): Promise<RepositoryRow[]> {
  // Filtered by provider in SQL, matched by URL in memory: normalizing a URL is
  // not something to express in SQL, and the candidate set is a handful of rows.
  const candidates = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.provider, provider));
  return candidates.filter((repo) => sameRepository(repo.url, remoteUrl));
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .send({ error: "Unauthorized", message: "invalid webhook signature" });
}

export const gitWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Signatures are over the bytes we received, so the body must survive
  // unparsed. Scoped to this plugin — every other route keeps Fastify's parser.
  app.addContentTypeParser(
    ["application/json", "application/x-www-form-urlencoded"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/webhooks/git/:provider",
    { bodyLimit: MAX_PAYLOAD_BYTES, schema: { params: paramsSchema } },
    async (request, reply) => {
      const { provider: providerId } = request.params as { provider: ProviderId };
      const provider = app.providers.get(providerId);
      const source = provider.refEvents;
      if (!source) {
        return reply.code(404).send({
          error: "Not Found",
          message: `${provider.label} does not deliver webhooks`,
        });
      }

      const rawBody = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(String(request.body ?? ""));

      let json: unknown = null;
      try {
        json = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Left null: a body we cannot read normalizes to no events below.
      }

      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value;
      }
      const hook: RawWebhook = { headers, rawBody, json };

      const events = source.parseEvents(hook);
      // A ping, a tag push, a comment: providers send far more than we asked
      // for. 202 with nothing done is the honest answer, not an error.
      if (events.length === 0) return reply.code(202).send({ handled: 0 });

      const remoteUrl = events.find((e) => e.remoteUrl)?.remoteUrl;
      if (!remoteUrl) {
        return reply.code(202).send({ handled: 0 });
      }
      const repos = await repositoriesFor(app, providerId, remoteUrl);
      // An unknown repository must not be distinguishable from a bad secret:
      // both answer 401, so this endpoint cannot be used to enumerate what we
      // watch.
      if (repos.length === 0) return unauthorized(reply);

      // Which secret proves the sender depends on the provider: an App signs
      // every delivery with one instance-wide secret, while GitLab and Azure
      // DevOps carry the repository's own webhook token — the same one CI uses.
      const appSecret = app.integrations.githubApp?.webhookSecret ?? "";
      const verified = repos.filter(
        (repo) =>
          (appSecret !== "" && source.verifySignature(hook, appSecret)) ||
          source.verifySignature(hook, repo.webhookToken),
      );
      if (verified.length === 0) return unauthorized(reply);

      let handled = 0;
      for (const repo of verified) {
        await markWebhookSeen(app, repo.id);
        for (const event of events) {
          try {
            if (await handleRefEvent(app, repo, event, "webhook")) handled += 1;
          } catch (err) {
            // One event's failure never costs the delivery: the provider would
            // retry the whole batch, and the poller is still behind us.
            app.log.error(
              { err, repositoryId: repo.id, kind: event.kind },
              "webhook ref event failed",
            );
          }
        }
      }

      return reply.code(202).send({ handled });
    },
  );
};
