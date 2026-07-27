import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import { repositories, toPublicRepository, type RepositoryRow } from "../db/schema.js";
import { InvalidRepoPathError, normalizeTerraformPath } from "../lib/repo-path.js";
import { generateToken } from "../lib/tokens.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";
import {
  attachFailure,
  credentialRequestFrom,
  prepareCredential,
} from "../services/repository-credential-resolution.js";
import { verifyAndStore } from "../services/repository-verification.js";
import { credentialProperties } from "./repository-credential-schema.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/**
 * What a repository can be told to change. Absent by design: `iacType` (set at
 * creation, immutable in v1 — GP-100 has no mixed repos), `url` and `provider`.
 * Unknown keys are stripped by Fastify before the handler runs, so a request
 * made up entirely of them updates nothing — which the handler answers as such
 * rather than sending an empty UPDATE to Postgres.
 */
const updateRepositorySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    // GP-229: derived from the create shape, not restated. Both handlers accept
    // the same credential vocabulary and resolve it through the same function,
    // so neither can grow a mode the other lacks.
    ...credentialProperties(),
    defaultBranch: { type: "string", minLength: 1, maxLength: 200 },
    prCommentsEnabled: { type: "boolean" },
    // GP-60: long-form markdown context; editing it never re-verifies.
    contextMd: { type: ["string", "null"], maxLength: 50000 },
    // Subdirectory the Terraform lives in; "" moves it back to the repo root.
    terraformPath: { type: "string", maxLength: 500 },
  },
};

async function loadRepository(
  app: FastifyInstance,
  id: string,
): Promise<RepositoryRow | undefined> {
  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id));
  return repo;
}

export const repositoryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/repositories/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = await loadRepository(app, id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      return toPublicRepository(repo);
    },
  );

  // Update credentials (PAT) and/or default branch, then re-verify.
  app.patch(
    "/repositories/:id",
    { schema: { params: idParamsSchema, body: updateRepositorySchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const body = request.body as {
        accessToken?: string;
        credentialId?: string | null;
        installationId?: number;
        defaultBranch?: string;
        prCommentsEnabled?: boolean;
        contextMd?: string | null;
        terraformPath?: string;
      };

      const existing = await loadRepository(app, id);
      if (!existing) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      // Everything the caller sent was stripped as unknown (`iacType`, say, which
      // is immutable). Answering that plainly beats an empty UPDATE, which
      // Postgres rejects and the caller would read as a server fault.
      if (Object.keys(body).length === 0) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message:
            "nothing to update — a repository's provider, url and iacType are set when it is attached",
          fields: [],
        });
      }

      let terraformPath: string | undefined;
      try {
        if (body.terraformPath !== undefined) {
          terraformPath = normalizeTerraformPath(body.terraformPath);
        }
      } catch (err) {
        if (err instanceof InvalidRepoPathError) {
          return reply.code(422).send({
            error: "Unprocessable Entity",
            message: err.message,
            fields: [{ field: "terraformPath", message: err.message }],
          });
        }
        throw err;
      }

      const changingCredentials =
        body.accessToken !== undefined ||
        body.credentialId !== undefined ||
        body.installationId !== undefined;
      const changingBranch = body.defaultBranch !== undefined;
      const defaultBranch = body.defaultBranch ?? existing.defaultBranch;

      // GP-229: the same resolver the create path uses, so a repository cannot
      // be *edited* into a credential state creation would have refused — nor
      // the reverse, which was the original bug.
      let resolved;
      if (changingCredentials || changingBranch) {
        const prepared = await prepareCredential(app, {
          orgId: orgIdOf(request),
          provider: existing.provider,
          url: existing.url,
          ref: defaultBranch,
          request: credentialRequestFrom(body),
          existing,
        });
        if (!prepared.ok) return attachFailure(reply, prepared.error);
        resolved = prepared.resolved;
      }

      const [updated] = await app.db
        .update(repositories)
        .set({
          ...(resolved?.encryptedPat !== undefined
            ? { accessToken: resolved.encryptedPat }
            : {}),
          ...(resolved ? { credentialId: resolved.credentialId } : {}),
          ...(changingBranch ? { defaultBranch: body.defaultBranch } : {}),
          ...(body.prCommentsEnabled !== undefined
            ? { prCommentsEnabled: body.prCommentsEnabled }
            : {}),
          ...(body.contextMd !== undefined ? { contextMd: body.contextMd } : {}),
          // Moving the Terraform root changes what the next docs snapshot sees;
          // it says nothing about reachability, so it never re-verifies.
          ...(terraformPath !== undefined ? { terraformPath } : {}),
          // Reachability was just proven above; a second `ls-remote` would only
          // ask the same question twice.
          ...(resolved
            ? { connectionStatus: "ok" as const, verifiedAt: new Date() }
            : {}),
        })
        .where(eq(repositories.id, id))
        .returning();

      return toPublicRepository(
        updated ?? existing,
        resolved?.strategy?.mode ?? null,
      );
    },
  );

  // Manually check the connection with the stored credentials.
  app.post(
    "/repositories/:id/verify",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const repo = await loadRepository(app, id);
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      const { result } = await verifyAndStore(app, repo);
      if (result.ok) {
        return { ok: true, default_branch_found: result.defaultBranchFound };
      }
      return { ok: false, error: result.error };
    },
  );

  // Rotate the per-repository webhook token. The old token stops working the
  // moment this returns; the new one is shown once here, then masked forever
  // after (`toPublicRepository` omits it) — the same "shown once" contract as
  // the create response, which is why the value is spread back on by hand.
  app.post(
    "/repositories/:id/webhook-token",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const [updated] = await app.db
        .update(repositories)
        .set({ webhookToken: generateToken() })
        .where(eq(repositories.id, id))
        .returning();
      if (!updated) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      return { ...toPublicRepository(updated), webhookToken: updated.webhookToken };
    },
  );

  app.delete(
    "/repositories/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "project:manage")) return reply;
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(repositories)
        .where(eq(repositories.id, id))
        .returning({ id: repositories.id });
      if (deleted.length === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }
      return reply.code(204).send();
    },
  );
};
