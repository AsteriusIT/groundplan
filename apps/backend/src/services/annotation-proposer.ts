/**
 * GP-75: the AI annotation proposer.
 *
 * The model looks at a snapshot and suggests how to organise it — groups, and the
 * odd rename or hide. Everything it says is stored as `proposed` / `ai` and waits
 * for a person. There is no code path from here to `accepted`; that transition
 * exists only as an explicit PATCH from a human (GP-71).
 *
 * The guarantees this file is responsible for:
 *
 *   - **The model never invents an anchor.** Every address it returns must exist
 *     in the snapshot it was shown, or the proposal is dropped. A suggestion that
 *     points at nothing is not a suggestion, it is a hallucination with a label.
 *   - **Garbage in the response is dropped, not stored.** Individual malformed
 *     proposals are discarded (and logged); a response that is not JSON at all is
 *     an error the caller can retry, and *nothing* is written — including the
 *     cache, because a cached failure is a failure served forever.
 *   - **Asking twice is free.** The response is cached under the same key the rest
 *     of the AI layer uses — (kind, snapshot, prompt version, model) — so a repeat
 *     call makes no provider call at all.
 *   - **Proposals never duplicate.** A suggestion identical to an annotation that
 *     already exists, in any state, is skipped: re-running must not slowly bury
 *     the reviewer in copies of what they already dismissed.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { annotations, aiGenerations, type AnnotationRow } from "../db/schema.js";
import type { Graph } from "../graph/graph.js";
import { isTerraformAddress } from "../lib/tf-address.js";
import { capInput, loadPrompt, readCached, type AiProvider } from "./ai.js";

/** The kinds the proposer may suggest. Logical edges and notes are out of scope. */
const PROPOSABLE = ["group", "rename", "hide"] as const;
type ProposableType = (typeof PROPOSABLE)[number];

/** One suggestion, after parsing but before we have checked it against reality. */
export type RawProposal = {
  type: ProposableType;
  anchors: string[];
  label?: string;
  reason?: string;
};

/** Thrown when the response is not JSON we can read at all. Nothing is stored. */
export class MalformedProposalsError extends Error {
  constructor(cause: string) {
    super(`the model did not return usable JSON: ${cause}`);
    this.name = "MalformedProposalsError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Read the model's JSON. Tolerant of the two things models do even when told not
 * to — wrapping the object in a ```json fence, and padding it with a sentence —
 * because refusing those costs a retry and buys nothing.
 */
export function parseProposals(text: string): RawProposal[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  // The outermost {...} in whatever came back.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new MalformedProposalsError("no JSON object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new MalformedProposalsError(
      err instanceof Error ? err.message : "unparseable",
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) {
    throw new MalformedProposalsError("no `proposals` array");
  }

  // Individual items are shaped here and *judged* in `validProposals` — a single
  // bad apple must not cost the reviewer the whole basket.
  const out: RawProposal[] = [];
  for (const item of parsed.proposals) {
    if (!isRecord(item)) continue;
    const { type, anchors, label, reason } = item;
    if (typeof type !== "string" || !PROPOSABLE.includes(type as ProposableType)) continue;
    if (!Array.isArray(anchors) || !anchors.every((a) => typeof a === "string")) continue;
    out.push({
      type: type as ProposableType,
      anchors: anchors as string[],
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
    });
  }
  return out;
}

/** Per-type shape rules, mirroring the annotation model (GP-71). */
function wellFormed(proposal: RawProposal): boolean {
  const { type, anchors, label } = proposal;
  if (anchors.length === 0 || !anchors.every(isTerraformAddress)) return false;
  if (new Set(anchors).size !== anchors.length) return false;
  if (type === "group") return Boolean(label);
  if (type === "rename") return anchors.length === 1 && Boolean(label);
  return anchors.length === 1 && !label; // hide
}

/** The identity of a suggestion, for spotting one we already hold. */
const fingerprint = (type: string, anchors: string[], label: string | null): string =>
  `${type}|${[...anchors].sort((a, b) => (a < b ? -1 : 1)).join(",")}|${label ?? ""}`;

/**
 * Keep the proposals that are well-formed, anchored to resources that actually
 * exist in this snapshot, and not already on the board in some form. Returns what
 * survived and what did not, so the caller can log the difference — a proposer
 * whose output is being silently thrown away is a bug you want to find out about.
 */
export function validProposals(
  raw: RawProposal[],
  graph: Graph,
  existing: Pick<AnnotationRow, "type" | "anchors" | "label">[],
): { valid: RawProposal[]; dropped: { proposal: RawProposal; why: string }[] } {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const seen = new Set(
    existing.map((row) => fingerprint(row.type, row.anchors, row.label)),
  );

  const valid: RawProposal[] = [];
  const dropped: { proposal: RawProposal; why: string }[] = [];

  for (const proposal of raw) {
    if (!wellFormed(proposal)) {
      dropped.push({ proposal, why: "malformed for its type" });
      continue;
    }
    const missing = proposal.anchors.filter((a) => !nodeIds.has(a));
    if (missing.length > 0) {
      // The one failure mode that matters most: an address the model made up.
      dropped.push({ proposal, why: `unknown address(es): ${missing.join(", ")}` });
      continue;
    }
    const key = fingerprint(proposal.type, proposal.anchors, proposal.label ?? null);
    if (seen.has(key)) {
      dropped.push({ proposal, why: "already exists" });
      continue;
    }
    seen.add(key); // also dedupes the model against itself within one response
    valid.push(proposal);
  }
  return { valid, dropped };
}

/** Drain a stream to its full text. The proposer wants JSON, not a typewriter. */
async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

export type ProposeResult = {
  stored: AnnotationRow[];
  dropped: { proposal: RawProposal; why: string }[];
  /** True when the answer came from the cache and no model was called. */
  cached: boolean;
};

/**
 * Ask for proposals and store the ones that survive. See the file header for the
 * guarantees; the shape of this function is those guarantees in order.
 */
export async function proposeAnnotations(
  db: NodePgDatabase,
  provider: AiProvider,
  input: {
    repositoryId: string;
    snapshotId: string;
    commitSha: string;
    graph: Graph;
    /** Every annotation on this repo — the duplicate check spans all statuses. */
    existing: AnnotationRow[];
    /** The rendered brief (services/ai-input.buildProposalInput). */
    brief: string;
  },
): Promise<ProposeResult> {
  const model = provider.model;
  if (!model) throw new Error("the AI layer is disabled");

  const { system, version } = loadPrompt("annotation_proposals");
  const key = {
    kind: "annotation_proposals" as const,
    targetId: input.snapshotId,
    promptVersion: version,
    model,
  };

  const hit = await readCached(db, key);
  const text = hit
    ? hit.output
    : await collect(
        provider.stream({ system, prompt: capInput(input.brief) }).textStream,
      );

  // Throws before anything is written — a response we cannot read is a retriable
  // failure, and caching it would serve that failure forever.
  const raw = parseProposals(text);

  if (!hit) {
    await db
      .insert(aiGenerations)
      .values({ ...key, output: text })
      .onConflictDoNothing();
  }

  const { valid, dropped } = validProposals(raw, input.graph, input.existing);
  if (valid.length === 0) return { stored: [], dropped, cached: Boolean(hit) };

  const stored = await db
    .insert(annotations)
    .values(
      valid.map((proposal) => ({
        repositoryId: input.repositoryId,
        type: proposal.type,
        anchors: proposal.anchors,
        label: proposal.label ?? null,
        body: null,
        // The two fields that make this a suggestion rather than a decision.
        status: "proposed" as const,
        provenance: "ai" as const,
        reason: proposal.reason ?? null,
        createdFromSha: input.commitSha,
        createdBy: null,
      })),
    )
    .returning();

  return { stored: stored as AnnotationRow[], dropped, cached: Boolean(hit) };
}
