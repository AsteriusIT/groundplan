/**
 * GP-78: guided tours of a snapshot.
 *
 * A tour is an ordered walk through a diagram: each stop names some nodes, the
 * player flies the camera to them, and the model's text explains them. Two kinds,
 * one shape — a `change_tour` walks a reviewer through a pull request, a
 * `system_tour` shows a newcomer around an estate.
 *
 * The guarantees this file is responsible for:
 *
 *   - **The model never invents a stop.** Every anchor must exist in the graph the
 *     tour will be played against, or the stop is dropped. A stop the camera cannot
 *     fly to is not a stop; it is a paragraph with a broken promise attached.
 *   - **Garbage in the response is dropped, not stored.** A single unusable stop is
 *     discarded and logged; a response that is not JSON at all is a retriable error
 *     and *nothing* is written — cache included, because a cached failure is a
 *     failure served forever.
 *   - **An empty tour is a failure, not an answer.** Unlike the proposer, which may
 *     respectably have nothing to suggest, a tour that survives validation with no
 *     stops left has failed to do the one thing it was asked for. The caller gets
 *     an error it can retry, and again: nothing is cached.
 *   - **Asking twice is free.** Cached under the same key as the rest of the AI
 *     layer — (kind, snapshot, prompt version, model). And because a snapshot is
 *     immutable, a cached tour can never go stale: nothing an anchor points at can
 *     move underneath it.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { aiGenerations } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";
import {
  acquireGenerationLock,
  capInput,
  loadPrompt,
  readCached,
  type AiProvider,
} from "./ai.js";

/** The two kinds of tour, and the snapshot source each one describes. */
export type TourKind = "change_tour" | "system_tour";

/**
 * The lens the tour was written against, and which the player switches to. A
 * change tour is always told on the raw diagram; a system tour is told on the
 * adapted one when the repo has groups worth stopping at.
 */
export type TourView = "infra" | "adapted";

export type TourStep = {
  /** Node ids to frame. Empty means "the whole diagram" — the opener and closer. */
  anchors: string[];
  title: string;
  body: string;
};

export type Tour = {
  title: string;
  view: TourView;
  steps: TourStep[];
};

/** How many stops a tour may have. Past this it is the resource list read aloud. */
export const MAX_STEPS = 8;
/** How many nodes one stop may frame. Past this the camera is showing everything. */
export const MAX_ANCHORS = 5;

/** Thrown when the response is not a tour we can play. Nothing is stored. */
export class MalformedTourError extends Error {
  constructor(cause: string) {
    super(`the model did not return a usable tour: ${cause}`);
    this.name = "MalformedTourError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** A stop as the model wrote it — parsed, but not yet checked against reality. */
export type RawStep = { anchors: string[]; title: string; body: string };
export type RawTour = { title: string; steps: RawStep[] };

/**
 * Read the model's JSON. Tolerant of the two things models do even when told not
 * to — wrapping the object in a ```json fence and padding it with a sentence —
 * because refusing those costs a retry and buys nothing.
 */
export function parseTour(raw: string): RawTour {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new MalformedTourError("no JSON object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new MalformedTourError(
      err instanceof Error ? err.message : "unparseable",
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) {
    throw new MalformedTourError("no `steps` array");
  }

  // Individual stops are shaped here and *judged* in `validSteps` — one bad stop
  // must not cost the reader the whole tour.
  const steps: RawStep[] = [];
  for (const item of parsed.steps) {
    if (!isRecord(item)) continue;
    const title = text(item.title);
    const stepBody = text(item.body);
    if (!title || !stepBody) continue;
    // An absent `anchors` is a legitimate whole-diagram stop, not a malformed one.
    const anchors = item.anchors === undefined ? [] : item.anchors;
    if (!Array.isArray(anchors) || !anchors.every((a) => typeof a === "string")) {
      continue;
    }
    steps.push({ anchors: anchors as string[], title, body: stepBody });
  }

  return { title: text(parsed.title) ?? "Guided tour", steps };
}

export type DroppedStep = { step: RawStep; why: string };

/**
 * Keep the stops the player can actually fly to. Returns what survived and what
 * did not, so the caller can log the difference — a model whose tour is being
 * quietly thrown away is a bug you want to hear about.
 */
export function validSteps(
  raw: RawStep[],
  graph: Graph,
): { steps: TourStep[]; dropped: DroppedStep[] } {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  const steps: TourStep[] = [];
  const dropped: DroppedStep[] = [];

  for (const step of raw) {
    if (steps.length >= MAX_STEPS) {
      dropped.push({ step, why: `beyond the ${MAX_STEPS}-stop cap` });
      continue;
    }

    const missing = step.anchors.filter((a) => !nodeIds.has(a));
    if (missing.length > 0) {
      // The failure mode that matters most: an id the model made up. We drop the
      // whole stop rather than fly to the anchors that happen to exist — a stop
      // whose text is about four things and whose camera shows two is worse than
      // no stop at all.
      dropped.push({ step, why: `unknown node id(s): ${missing.join(", ")}` });
      continue;
    }

    const unique = [...new Set(step.anchors)];
    if (unique.length > MAX_ANCHORS) {
      dropped.push({ step, why: `${unique.length} anchors, over the ${MAX_ANCHORS} cap` });
      continue;
    }

    steps.push({ anchors: unique, title: step.title, body: step.body });
  }

  return { steps, dropped };
}

/** Drain a stream to its full text. A tour is JSON — there is nothing to typewrite. */
async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

export type TourResult = {
  tour: Tour;
  dropped: DroppedStep[];
  /** True when the answer came from the cache and no model was called. */
  cached: boolean;
};

/**
 * Ask for a tour and return the one that survives validation. See the file header
 * for the guarantees; the shape of this function is those guarantees in order.
 *
 * `graph` is the graph the tour will be *played* against, which is also the graph
 * its anchors are checked against — for a system tour that is the adapted
 * projection, not the raw snapshot. Validating against a different graph than the
 * player renders is how you ship a tour that flies to nowhere.
 */
export async function generateTour(
  db: NodePgDatabase,
  provider: AiProvider,
  input: {
    kind: TourKind;
    snapshotId: string;
    view: TourView;
    graph: Graph;
    /** The rendered brief (services/ai-input.build{Change,System}TourInput). */
    brief: string;
  },
): Promise<TourResult> {
  const model = provider.model;
  if (!model) throw new Error("the AI layer is disabled");

  const { system, version } = loadPrompt(input.kind);
  const key = {
    kind: input.kind,
    targetId: input.snapshotId,
    promptVersion: version,
    model,
  };

  const hit = await readCached(db, key);

  let raw: string;
  if (hit) {
    raw = hit.output;
  } else {
    // Synchronously, before the first await of the generation itself: a
    // double-clicked "Take the tour" should cost one tour, not two.
    const release = acquireGenerationLock(input.kind, input.snapshotId);
    try {
      raw = await collect(
        provider.stream({ system, prompt: capInput(input.brief) }).textStream,
      );
    } finally {
      release();
    }
  }

  // Both of these throw *before* anything is written. A response we cannot read,
  // and a tour with no stops left, are retriable failures — and a cached failure
  // is a failure served forever.
  const parsed = parseTour(raw);
  const { steps, dropped } = validSteps(parsed.steps, input.graph);
  if (steps.length === 0) {
    throw new MalformedTourError("no stop survived validation");
  }

  if (!hit) {
    await db
      .insert(aiGenerations)
      .values({ ...key, output: raw })
      .onConflictDoNothing();
  }

  return {
    tour: { title: parsed.title, view: input.view, steps },
    dropped,
    cached: Boolean(hit),
  };
}
