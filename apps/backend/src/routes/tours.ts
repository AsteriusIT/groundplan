/**
 * GP-78: the guided tour's HTTP surface.
 *
 *   GET  /snapshots/:id/tour  — the cached tour, or 404 if none has been generated
 *   POST /snapshots/:id/tour  — generate one; `{regenerate:true}` re-runs
 *
 * There is no `kind` in the path, unlike the prose routes. A tour's kind follows
 * from what the snapshot *is* — a plan is a change to walk through, an hcl snapshot
 * is a system to be shown around — so the caller cannot pick the wrong one and
 * there is no wrong-source case to answer.
 *
 * The response is JSON, not a stream. A half-parsed tour is not a tour you can play.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";

import {
  annotations,
  graphSnapshots,
  projects,
  repositories,
  type GraphSnapshotRow,
  type RepositoryRow,
} from "../db/schema.js";
import { projectAdapted } from "../graph/adapted.js";
import type { Graph } from "../graph/graph.js";
import {
  buildChangeTourInput,
  buildSystemTourInput,
  type ContextInput,
} from "../services/ai-input.js";
import {
  AiInFlightError,
  deleteCached,
  loadPrompt,
  readCached,
  type AiProvider,
} from "../services/ai.js";
import {
  generateTour,
  MalformedTourError,
  parseTour,
  validSteps,
  type Tour,
  type TourKind,
  type TourView,
} from "../services/tour.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

/**
 * What a snapshot's source makes it a tour *of*. A Kubernetes namespace read
 * (GP-97) has no tour: the AI layer is grounded in Terraform snapshots and their
 * repository context, and `load` below — which joins through `repositories` —
 * cannot return one. It is spelled out rather than left to the join, so the next
 * producer has to decide what its tour is instead of inheriting one by accident.
 */
const KIND_FOR_SOURCE: Record<GraphSnapshotRow["source"], TourKind | null> = {
  plan: "change_tour",
  hcl: "system_tour",
  k8s_namespace: null,
};

type Prepared = {
  kind: TourKind;
  view: TourView;
  /** The graph the tour plays against — and therefore the one anchors are checked against. */
  graph: Graph;
  brief: string;
};

/**
 * Work out what tour this snapshot deserves, on which lens, grounded in what.
 *
 * The one subtlety: a system tour is told on the *adapted* diagram when the repo
 * has groups, because a tour that stops at "the storefront" is worth more than one
 * that stops at seven addresses. When it does, the adapted projection is both what
 * the model is shown and what its anchors are validated against — validating
 * against a graph the player does not render is how you ship a tour that flies to
 * nowhere.
 */
async function prepare(
  app: FastifyInstance,
  snapshot: GraphSnapshotRow,
  repo: RepositoryRow,
  context: ContextInput,
): Promise<Prepared | null> {
  const kind = KIND_FOR_SOURCE[snapshot.source];
  if (kind === null) return null; // a snapshot nothing here knows how to narrate

  if (kind === "change_tour") {
    return {
      kind,
      view: "infra",
      graph: snapshot.graph,
      brief: buildChangeTourInput({
        prNumber: snapshot.prNumber,
        summaryMd: snapshot.summaryMd,
        graph: snapshot.graph,
        context,
      }),
    };
  }

  const layer = await app.db
    .select()
    .from(annotations)
    .where(eq(annotations.repositoryId, repo.id));

  const hasGroups = layer.some(
    (row) => row.type === "group" && row.status === "resolved",
  );
  // No groups to stop at ⇒ the adapted projection buys the tour nothing, and the
  // raw view is where the user already is. Don't move them for no reason.
  const view: TourView = hasGroups ? "adapted" : "infra";
  const graph = hasGroups ? projectAdapted(snapshot.graph, layer) : snapshot.graph;

  return {
    kind,
    view,
    graph,
    brief: buildSystemTourInput({
      repo,
      graph,
      context,
      annotations: layer.filter((row) => row.status === "resolved"),
    }),
  };
}

type Loaded = {
  snapshot: GraphSnapshotRow;
  repo: RepositoryRow;
  context: ContextInput;
};

/** The snapshot plus everything a tour is grounded in. */
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

/**
 * Replay a cached tour. The cache stores the model's raw text, so a replay
 * re-parses and re-validates it — which costs nothing and means a stop can never
 * outlive the graph it points at, even if the projection changes shape under it.
 */
function replay(raw: string, prepared: Prepared): Tour | null {
  try {
    const parsed = parseTour(raw);
    const { steps } = validSteps(parsed.steps, prepared.graph);
    if (steps.length === 0) return null;
    return { title: parsed.title, view: prepared.view, steps };
  } catch {
    return null;
  }
}

const disabled = { error: "Not Found", message: "the AI layer is disabled" };
const notFound = { error: "Not Found", message: "snapshot not found" };

export const tourRoutes: FastifyPluginAsync = async (app) => {
  // The tour this snapshot already has, if any. 404 (not an empty tour) so the
  // frontend can tell "never generated" from "generated nothing".
  app.get(
    "/snapshots/:id/tour",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const model: string | null = app.ai.model;
      if (!model) return reply.code(404).send(disabled);

      const loaded = await load(app, id);
      if (!loaded) return reply.code(404).send(notFound);

      const prepared = await prepare(app, loaded.snapshot, loaded.repo, loaded.context);
      if (!prepared) return reply.code(404).send(notFound);
      const row = await readCached(app.db, {
        kind: prepared.kind,
        targetId: id,
        promptVersion: loadPrompt(prepared.kind).version,
        model,
      });
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "no tour for this snapshot" });
      }

      const tour = replay(row.output, prepared);
      if (!tour) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "no tour for this snapshot" });
      }
      return { tour, model, cached: true };
    },
  );

  // Generate a tour. A cache hit replays the stored JSON with no provider call.
  app.post(
    "/snapshots/:id/tour",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { regenerate?: unknown };

      const model: string | null = app.ai.model;
      if (!model) return reply.code(404).send(disabled);

      const loaded = await load(app, id);
      if (!loaded) return reply.code(404).send(notFound);

      const prepared = await prepare(app, loaded.snapshot, loaded.repo, loaded.context);
      if (!prepared) return reply.code(404).send(notFound);

      if (body.regenerate === true) {
        await deleteCached(app.db, prepared.kind, id);
      }

      try {
        const result = await generateTour(app.db, app.ai as AiProvider, {
          kind: prepared.kind,
          snapshotId: id,
          view: prepared.view,
          graph: prepared.graph,
          brief: prepared.brief,
        });

        if (result.dropped.length > 0) {
          // Never silent: a model whose stops we are throwing away is a prompt
          // problem, and the only place it shows up is here.
          request.log.warn(
            { snapshotId: id, kind: prepared.kind, dropped: result.dropped },
            "tour stops dropped",
          );
        }

        return {
          tour: result.tour,
          model,
          cached: result.cached,
          dropped: result.dropped.length,
        };
      } catch (err) {
        if (err instanceof AiInFlightError) {
          return reply.code(409).send({ error: "Conflict", message: err.message });
        }
        if (err instanceof MalformedTourError) {
          request.log.warn({ err, snapshotId: id }, "unusable tour response");
          return reply.code(502).send({ error: "Bad Gateway", message: err.message });
        }
        throw err;
      }
    },
  );
};
