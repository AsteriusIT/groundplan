import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";

import {
  ingestionEvents,
  publicEventColumns,
  repositories,
} from "../db/schema.js";
import { safeEqual } from "../lib/tokens.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** 10 MB — the largest ingestion payload we accept. */
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

const webhookParamsSchema = {
  type: "object",
  required: ["repositoryId"],
  additionalProperties: false,
  properties: { repositoryId: { type: "string", pattern: UUID_PATTERN } },
};

const webhookBodySchema = {
  type: "object",
  required: ["ref", "commit_sha", "event", "payload"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", minLength: 1, maxLength: 500 },
    commit_sha: { type: "string", minLength: 1, maxLength: 200 },
    event: { type: "string", enum: ["push", "pull_request"] },
    payload: { type: "object" },
  },
};

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

export const ingestionRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/webhooks/ci/:repositoryId",
    {
      bodyLimit: MAX_PAYLOAD_BYTES,
      schema: { params: webhookParamsSchema, body: webhookBodySchema },
    },
    async (request, reply) => {
      const { repositoryId } = request.params as { repositoryId: string };
      const body = request.body as {
        ref: string;
        commit_sha: string;
        event: "push" | "pull_request";
        payload: Record<string, unknown>;
      };

      const [repo] = await app.db
        .select({
          id: repositories.id,
          webhookToken: repositories.webhookToken,
        })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const header = request.headers["x-groundplan-token"];
      const provided = Array.isArray(header) ? header[0] : header;
      if (!provided || !safeEqual(provided, repo.webhookToken)) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", message: "invalid webhook token" });
      }

      const [row] = await app.db
        .insert(ingestionEvents)
        .values({
          repositoryId,
          ref: body.ref,
          commitSha: body.commit_sha,
          event: body.event,
          payload: body.payload,
        })
        .returning({ id: ingestionEvents.id });

      return reply.code(202).send({ id: row?.id });
    },
  );

  app.get(
    "/repositories/:id/events",
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

      return app.db
        .select(publicEventColumns)
        .from(ingestionEvents)
        .where(eq(ingestionEvents.repositoryId, id))
        .orderBy(desc(ingestionEvents.receivedAt))
        .limit(20);
    },
  );
};
