/**
 * GP-62: the AI layer's HTTP surface.
 *
 * Both product features (the PR summary, GP-63; the docs explanation, GP-65) are
 * prose *about a snapshot*, so they share one uniform route pair rather than
 * inventing a PR-shaped and a docs-shaped endpoint for the same thing:
 *
 *   GET  /ai/status               — is the layer on, and with which model
 *   GET  /snapshots/:id/ai/:kind  — the cached prose, or 404 if none yet
 *   POST /snapshots/:id/ai/:kind  — generate (streamed); `{regenerate:true}` re-runs
 *
 * `kind` must match the snapshot's source (a plan gets a PR summary, a docs
 * snapshot gets an explanation) — the snapshot id alone can't be trusted to
 * pick the right prompt.
 */
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { and, asc, eq } from "drizzle-orm";

import {
  annotations,
  graphSnapshots,
  projects,
  repositories,
  toPublicAiGeneration,
  type GraphSnapshotRow,
  type RepositoryRow,
} from "../db/schema.js";
import {
  buildDocsExplainInput,
  buildPrSummaryInput,
  type ContextInput,
} from "../services/ai-input.js";
import {
  AiDisabledError,
  AiInFlightError,
  deleteCached,
  loadPrompt,
  readCached,
  streamGeneration,
  type AiKind,
} from "../services/ai.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const generationParamsSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    kind: { type: "string", enum: ["pr_summary", "docs_explain"] },
  },
};

/**
 * A provider failure, said in one line a human can act on ("invalid x-api-key",
 * "model not found", "rate limit exceeded"). Only the message — never the
 * error's response body, which can be long and echo back what we sent.
 */
function providerMessage(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  return err.message.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

/** Which snapshot source each generation kind is allowed to describe. */
const KIND_SOURCE: Record<AiKind, GraphSnapshotRow["source"]> = {
  pr_summary: "plan",
  docs_explain: "hcl",
};

type Loaded = {
  snapshot: GraphSnapshotRow;
  repo: RepositoryRow;
  context: ContextInput;
};

/** The snapshot plus everything the prompt is grounded in. */
async function load(
  app: FastifyInstance,
  snapshotId: string,
): Promise<Loaded | undefined> {
  const [row] = await app.db
    .select({
      snapshot: graphSnapshots,
      repo: repositories,
      projectName: projects.name,
      projectContextMd: projects.contextMd,
    })
    .from(graphSnapshots)
    .innerJoin(repositories, eq(graphSnapshots.repositoryId, repositories.id))
    .innerJoin(projects, eq(repositories.projectId, projects.id))
    .where(eq(graphSnapshots.id, snapshotId));
  if (!row) return undefined;

  return {
    snapshot: row.snapshot,
    repo: row.repo,
    context: {
      projectName: row.projectName,
      projectContextMd: row.projectContextMd,
      repoContextMd: row.repo.contextMd,
    },
  };
}

/** Render the grounding brief for this kind of generation. */
async function buildInput(
  app: FastifyInstance,
  kind: AiKind,
  loaded: Loaded,
): Promise<string> {
  const { snapshot, repo, context } = loaded;

  if (kind === "pr_summary") {
    return buildPrSummaryInput({
      prNumber: snapshot.prNumber,
      summaryMd: snapshot.summaryMd,
      graph: snapshot.graph,
      context,
    });
  }

  // GP-65 grounds the docs explanation in the human annotation layer too.
  const notes = await app.db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.repositoryId, repo.id),
        eq(annotations.status, "resolved"),
      ),
    )
    .orderBy(asc(annotations.createdAt));

  return buildDocsExplainInput({
    repo,
    graph: snapshot.graph,
    context,
    annotations: notes,
  });
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // Is the AI layer configured? The frontend renders no AI surface when it isn't.
  app.get("/ai/status", async () => ({
    enabled: app.ai.model !== null,
    model: app.ai.model,
  }));

  // The cached prose for this snapshot, if it has been generated. 404 (not an
  // empty body) so the frontend can tell "never generated" from "generated
  // nothing" without guessing.
  app.get(
    "/snapshots/:id/ai/:kind",
    { schema: { params: generationParamsSchema } },
    async (request, reply) => {
      const { id, kind } = request.params as { id: string; kind: AiKind };
      if (!app.ai.model) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "the AI layer is disabled" });
      }

      const row = await readCached(app.db, {
        kind,
        targetId: id,
        promptVersion: loadPrompt(kind).version,
        model: app.ai.model,
      });
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "no generation for this snapshot" });
      }
      return toPublicAiGeneration(row);
    },
  );

  // Generate prose for a snapshot, streamed as plain text (the AI SDK's `text`
  // stream protocol, which `useCompletion` reads directly). A cache hit replays
  // the stored text instead — same response shape, no provider call.
  app.post(
    "/snapshots/:id/ai/:kind",
    // No body schema on purpose: the body is optional (`{regenerate: true}` is
    // the only field we read), and the AI SDK's `useCompletion` always posts a
    // `{prompt}` we deliberately ignore — the prompt is built here, from the
    // snapshot, and is never something a client gets to supply.
    { schema: { params: generationParamsSchema } },
    async (request, reply) => {
      const { id, kind } = request.params as { id: string; kind: AiKind };
      const body = (request.body ?? {}) as { regenerate?: unknown };
      const regenerate = body.regenerate === true;

      if (!app.ai.model) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "the AI layer is disabled" });
      }

      const loaded = await load(app, id);
      if (!loaded) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "snapshot not found" });
      }
      if (loaded.snapshot.source !== KIND_SOURCE[kind]) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: `${kind} is not available for a ${loaded.snapshot.source} snapshot`,
        });
      }

      if (regenerate) await deleteCached(app.db, kind, id);

      const cached = await readCached(app.db, {
        kind,
        targetId: id,
        promptVersion: loadPrompt(kind).version,
        model: app.ai.model,
      });
      if (cached) {
        return reply.type("text/plain; charset=utf-8").send(cached.output);
      }

      const input = await buildInput(app, kind, loaded);

      let chunks: AsyncIterable<string>;
      try {
        chunks = streamGeneration(app.db, app.ai, { kind, targetId: id, input });
      } catch (err) {
        if (err instanceof AiInFlightError) {
          return reply.code(409).send({ error: "Conflict", message: err.message });
        }
        if (err instanceof AiDisabledError) {
          return reply
            .code(404)
            .send({ error: "Not Found", message: "the AI layer is disabled" });
        }
        throw err;
      }

      // Pull the first chunk BEFORE committing to a streamed response. A provider
      // that is going to fail (bad key, unknown model, rate limit) fails here,
      // while we can still answer with a clean status and a JSON body. Answering
      // first and failing later would hand Fastify an object to serialise as
      // text/plain, and the caller would get an opaque 500 instead of the reason.
      const iterator = chunks[Symbol.asyncIterator]();
      let first: IteratorResult<string>;
      try {
        first = await iterator.next();
      } catch (err) {
        request.log.error({ err, kind, targetId: id }, "AI generation failed");
        return reply.code(502).send({
          error: "Bad Gateway",
          message: `the AI provider failed: ${providerMessage(err)}`,
        });
      }

      async function* prose(): AsyncGenerator<string> {
        if (first.done) return;
        yield first.value;
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) return;
            yield next.value;
          }
        } catch (err) {
          // Mid-stream failure: the status line is long gone, so there is no
          // clean error left to send. End the (partial) stream and log it —
          // nothing is cached, so the next request retries from scratch.
          request.log.error({ err, kind, targetId: id }, "AI generation failed mid-stream");
        }
      }

      return reply
        .type("text/plain; charset=utf-8")
        .send(Readable.from(prose(), { objectMode: false }));
    },
  );
};
