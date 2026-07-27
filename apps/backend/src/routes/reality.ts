/**
 * GP-208: pushing and reading what actually exists.
 *
 * The push is a webhook beside the plan and drift ones, on the same repository
 * secret — a CI job has a secret, not a bearer token. What it carries is a
 * **graph the caller's CLI derived**, never a state file: the endpoint refuses
 * one outright, and says how to do it properly.
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import { repositories } from "../db/schema.js";
import { InvalidGraphError } from "../graph/graph.js";
import {
  RawStateRejectedError,
  latestRealitySnapshot,
  recordReality,
} from "../services/reality.js";
import { ciTokenAuthorized, tokenFromHeader } from "../services/webhook-auth.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** 10 MB — the same cap every ingestion endpoint takes. */
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

const realityBodySchema = {
  type: "object",
  required: ["ref", "commit_sha", "payload"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", minLength: 1, maxLength: 500 },
    commit_sha: { type: "string", minLength: 1, maxLength: 200 },
    /** Informational: which Terraform wrote the state the CLI read. */
    terraform_version: { type: "string", maxLength: 50 },
    /** The derived GraphSnapshot. Validated against the graph schema below. */
    payload: { type: "object" },
  },
};

type RealityBody = {
  ref: string;
  commit_sha: string;
  terraform_version?: string;
  payload: Record<string, unknown>;
};

/** The CI-facing half: `POST /webhooks/ci/:repositoryId/state`. */
export const realityIngestionRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/webhooks/ci/:repositoryId/state",
    {
      bodyLimit: MAX_PAYLOAD_BYTES,
      schema: { params: repositoryParamsSchema, body: realityBodySchema },
    },
    async (request, reply) => {
      const { repositoryId } = request.params as { repositoryId: string };
      const body = request.body as RealityBody;

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

      if (repo.iacType === "kubernetes") {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message:
            "this repository holds kubernetes manifests — there is no Terraform state behind it. Attach the cluster itself for a live view of what is running.",
        });
      }

      try {
        const snapshot = await recordReality(app.db, {
          repositoryId,
          ref: body.ref,
          commitSha: body.commit_sha,
          graph: body.payload,
          terraformVersion: body.terraform_version ?? null,
        });
        return reply
          .code(202)
          .send({ id: snapshot.id, nodes: snapshot.graph.nodes.length });
      } catch (err) {
        // The one refusal this whole story is built around, and the ordinary
        // "that is not a graph" — both 422, both storing nothing.
        if (err instanceof RawStateRejectedError) {
          return reply
            .code(422)
            .send({ error: "Unprocessable Entity", message: err.message });
        }
        if (err instanceof InvalidGraphError) {
          return reply.code(422).send({
            error: "Unprocessable Entity",
            message: `that payload is not a graph snapshot: ${err.message}`,
          });
        }
        throw err;
      }
    },
  );
};

/** The reader-facing half, org-scoped: `GET /repositories/:id/reality`. */
export const realityRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/repositories/:id/reality",
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

      const snapshot = await latestRealitySnapshot(app.db, id);
      if (!snapshot) {
        // 404, never an empty graph: "nobody pushed a state" and "the estate is
        // empty" are different answers, and only one of them is alarming.
        return reply.code(404).send({
          error: "Not Found",
          message: "no reality snapshot for this repository yet",
        });
      }
      return snapshot;
    },
  );
};
