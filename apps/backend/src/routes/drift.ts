/**
 * GP-206: pushing and reading a drift measurement.
 *
 * Two routes, two audiences. The push is a **webhook** — a nightly cron job has
 * the repository's secret, not an OIDC bearer token — so it sits beside the plan
 * ingestion, exempt from the global auth hook and authenticating on the same
 * secret (`services/webhook-auth`). The read is org-scoped like everything a
 * tenant owns.
 *
 * The endpoint refuses anything that is not a refresh-only plan, and refuses it
 * at the point of failure: a `curl -sf` in somebody's pipeline goes red tonight
 * rather than a diagram quietly claiming their estate drifted in ways their own
 * pull request proposed.
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import { repositories } from "../db/schema.js";
import { NotRefreshOnlyError } from "../graph/drift.js";
import { driftStateFor, recordDrift } from "../services/drift.js";
import { ciTokenAuthorized, tokenFromHeader } from "../services/webhook-auth.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** 10 MB — the same cap the plan webhook takes; a refresh-only plan is smaller. */
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

const repositoryParamsSchema = {
  type: "object",
  required: ["repositoryId"],
  additionalProperties: false,
  properties: { repositoryId: { type: "string", pattern: UUID_PATTERN } },
};

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/**
 * No `event` and no `pr_number`: a measurement is always of the default branch.
 * The sha is the load-bearing field — it is what the report is anchored to, and
 * what tells us later that main has moved on.
 */
const driftBodySchema = {
  type: "object",
  required: ["ref", "commit_sha", "payload"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", minLength: 1, maxLength: 500 },
    commit_sha: { type: "string", minLength: 1, maxLength: 200 },
    payload: { type: "object" },
  },
};

type DriftBody = {
  ref: string;
  commit_sha: string;
  payload: Record<string, unknown>;
};

/** The CI-facing half: `POST /webhooks/ci/:repositoryId/drift`. */
export const driftIngestionRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/webhooks/ci/:repositoryId/drift",
    {
      bodyLimit: MAX_PAYLOAD_BYTES,
      schema: { params: repositoryParamsSchema, body: driftBodySchema },
    },
    async (request, reply) => {
      const { repositoryId } = request.params as { repositoryId: string };
      const body = request.body as DriftBody;

      const [repo] = await app.db
        .select()
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const provided = tokenFromHeader(request.headers["x-groundplan-token"]);
      if (!(await ciTokenAuthorized(app.db, provided, repo))) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", message: "invalid webhook token" });
      }

      // Drift is a Terraform question. A manifests repository has no state to
      // refresh — its reality lives in a cluster, which the live-cluster views
      // already read (GP-94), so sending a plan here is a misconfiguration.
      if (repo.iacType === "kubernetes") {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message:
            "this repository holds kubernetes manifests — there is no Terraform state to refresh. Attach the cluster itself for a live view of what is running.",
        });
      }

      try {
        const row = await recordDrift(app.db, {
          repositoryId,
          ref: body.ref,
          commitSha: body.commit_sha,
          plan: body.payload,
        });
        return reply
          .code(202)
          .send({ id: row.id, drifted: row.report.counts.total });
      } catch (err) {
        if (err instanceof NotRefreshOnlyError) {
          // 422 and nothing stored: half an answer about somebody's estate is
          // worse than none, and the message names the command that produces the
          // right artefact.
          return reply
            .code(422)
            .send({ error: "Unprocessable Entity", message: err.message });
        }
        throw err;
      }
    },
  );
};

/** The reader-facing half, org-scoped: `GET /repositories/:id/drift`. */
export const driftRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/repositories/:id/drift",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [repo] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, id));
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const state = await driftStateFor(app.db, id);
      if (!state) {
        // 404, not an empty report: "nobody has measured this" and "nothing has
        // drifted" are different answers, and only one of them is reassuring.
        return reply.code(404).send({
          error: "Not Found",
          message: "this repository has never been measured for drift",
        });
      }
      return state;
    },
  );
};
