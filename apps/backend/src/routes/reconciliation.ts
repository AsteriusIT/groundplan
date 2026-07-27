/**
 * GP-209: the cloud compared with the code.
 *
 * Its own file because it is its own question. `reality.ts` owns *receiving*
 * what exists; this owns *comparing* it with what the repository says should
 * exist — and the comparison has a vocabulary of its own that must never blur
 * into the plan's (see `graph/reconcile.ts`).
 */
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import { repositories } from "../db/schema.js";
import { reconcile, summarizeReconciliation } from "../graph/reconcile.js";
import { latestDocsSnapshot } from "../services/policy.js";
import { latestRealitySnapshot } from "../services/reality.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

export const reconciliationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GP-209: the cloud compared with the code — what nothing here describes,
   * what nothing out there has, and what the two disagree about.
   *
   * Computed on read rather than stored. Both sides are already snapshots, the
   * comparison is a pure function of them, and storing a third artefact derived
   * from two others would only create a way for it to fall behind them.
   *
   * **Both sides are always named.** The response carries the code's commit and
   * the moment the estate was observed, because a comparison whose age you
   * cannot see is one a reader will assume is live. It is not, ever: the reality
   * side is as old as the last `push-state`.
   *
   * 404 when either side is missing. A view built from one graph and an absence
   * would report a whole estate as unmanaged, or as never applied, and either
   * would be a confident lie.
   */
  app.get(
    "/repositories/:id/reconciliation",
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

      const [reality, code] = await Promise.all([
        latestRealitySnapshot(app.db, id),
        latestDocsSnapshot(app.db, id),
      ]);
      if (!reality) {
        return reply.code(404).send({
          error: "Not Found",
          message:
            "no reality snapshot for this repository yet — push one with `groundplan push-state`",
        });
      }
      if (!code) {
        return reply.code(404).send({
          error: "Not Found",
          message:
            "no documentation of the default branch to compare against — generate it first",
        });
      }

      const result = reconcile(code.graph, reality.graph);
      return {
        ...result,
        summaryMd: summarizeReconciliation(result),
        code: {
          snapshotId: code.id,
          ref: code.ref,
          commitSha: code.commitSha,
          createdAt: code.createdAt,
        },
        reality: {
          snapshotId: reality.id,
          ref: reality.ref,
          commitSha: reality.commitSha,
          /** When the state was read — the age of everything on the right. */
          observedAt: reality.createdAt,
          terraformVersion: reality.stats["terraformVersion"] ?? null,
        },
      };
    },
  );
};
