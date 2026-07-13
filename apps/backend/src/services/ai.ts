/**
 * GP-62: the AI layer's foundation — provider, versioned prompts, cache, lock.
 *
 * Everything the product generates goes through `streamGeneration`. It is the
 * only place that talks to a model, so the guarantees below hold layer-wide:
 *
 *   - **The API key is the feature flag.** No key ⇒ `provider.model` is null and
 *     nothing downstream can call a model, by construction.
 *   - **Prompts are files, not string literals** (`prompts/*.md`), and their
 *     content hash *is* the prompt version — editing a prompt invalidates the
 *     cache with no manual bump to forget.
 *   - **Deterministic in, prose out.** Callers pass an already-rendered input
 *     built from our own deterministic outputs — never a raw plan.json.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { AppEnv } from "../config/env.js";
import { aiGenerations, type AiGenerationRow } from "../db/schema.js";

export type AiKind = "pr_summary" | "docs_explain";

export type AiUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type AiStream = {
  /** Prose, chunk by chunk, as the model produces it. */
  textStream: AsyncIterable<string>;
  /** Token usage. Only settles once `textStream` has been fully consumed. */
  usage: Promise<AiUsage>;
};

/**
 * The seam between us and the model. Tests inject a stub so the whole AI layer
 * (routes, cache, lock, persistence) is exercised offline and deterministically.
 */
export type AiProvider = {
  /** The model in use, or null when no API key is configured (AI layer off). */
  readonly model: string | null;
  /** Throws `AiDisabledError` when `model` is null. */
  stream(opts: { system: string; prompt: string }): AiStream;
};

/** Thrown when a generation is attempted while the AI layer has no API key. */
export class AiDisabledError extends Error {
  constructor() {
    super("the AI layer is disabled (no AI_API_KEY configured)");
    this.name = "AiDisabledError";
  }
}

/** Thrown when a generation for the same target is already running. */
export class AiInFlightError extends Error {
  constructor() {
    super("a generation is already in progress for this target");
    this.name = "AiInFlightError";
  }
}

/**
 * Ceiling on the grounding text we send. Our inputs are deterministic summaries,
 * so they are small by construction — this is a backstop against a pathological
 * snapshot (thousands of resources) turning into a surprise bill, not a real
 * expectation. Truncation is announced in-band so the model never silently
 * reasons about a system it has only half seen.
 */
export const MAX_INPUT_CHARS = 24_000;

/** Cap grounding input, telling the model when (and that) it was cut. */
export function capInput(input: string, max: number = MAX_INPUT_CHARS): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n\n[input truncated — this system is larger than shown]`;
}

// Prompts live at the package root (`prompts/`), like `schema/`, so they survive
// the tsc build unchanged — two levels up in both `src/services` and
// `dist/services` layouts.
const PROMPT_FILES: Record<AiKind, string> = {
  pr_summary: "pr-summary.md",
  docs_explain: "docs-explain.md",
};

export type Prompt = {
  /** The system prompt: the instructions for this kind of generation. */
  system: string;
  /** Short content hash — changing the file changes this, invalidating the cache. */
  version: string;
};

const promptCache = new Map<AiKind, Prompt>();

/** Read (and memoise) a prompt file, versioned by the hash of its contents. */
export function loadPrompt(kind: AiKind): Prompt {
  const cached = promptCache.get(kind);
  if (cached) return cached;

  const path = fileURLToPath(
    new URL(`../../prompts/${PROMPT_FILES[kind]}`, import.meta.url),
  );
  const system = readFileSync(path, "utf8");
  const version = createHash("sha256").update(system).digest("hex").slice(0, 12);

  const prompt = { system, version };
  promptCache.set(kind, prompt);
  return prompt;
}

/** The real provider, backed by the Vercel AI SDK. Disabled without an API key. */
export function realAiProvider(env: AppEnv): AiProvider {
  if (!env.aiApiKey) {
    return {
      model: null,
      stream() {
        throw new AiDisabledError();
      },
    };
  }

  const anthropic = createAnthropic({ apiKey: env.aiApiKey });
  const model = env.aiModel;

  return {
    model,
    stream({ system, prompt }) {
      // The SDK routes provider errors to `onError` and lets `textStream` end
      // with a generic "No output generated" — which tells an operator nothing.
      // Capture the real cause so the route can say *why* it failed: bad key,
      // unknown model, rate limit.
      let failure: unknown;
      const result = streamText({
        model: anthropic(model),
        system,
        prompt,
        onError({ error }) {
          failure = error;
        },
      });

      async function* textStream(): AsyncGenerator<string> {
        try {
          for await (const chunk of result.textStream) yield chunk;
        } catch (err) {
          throw asError(failure ?? err);
        }
        // A provider error can end the stream cleanly-but-empty; onError still
        // fired, so an empty success is really a failure.
        if (failure !== undefined) throw asError(failure);
      }

      // `result.usage` is a PromiseLike (it settles only once the stream is
      // drained); Promise.resolve gives us the real Promise our type wants.
      const usage = Promise.resolve(result.usage).then((u) => ({
        inputTokens: u.inputTokens ?? null,
        outputTokens: u.outputTokens ?? null,
      }));
      // A failed generation rejects this too, and nobody awaits it on that path.
      // Mark it handled so a provider outage can't take the process down with an
      // unhandled rejection.
      usage.catch(() => undefined);

      return { textStream: textStream(), usage };
    },
  };
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "unknown provider error");
}

export type CacheKey = {
  kind: AiKind;
  targetId: string;
  promptVersion: string;
  model: string;
};

/** The cached generation for this exact (kind, target, prompt, model), if any. */
export async function readCached(
  db: NodePgDatabase,
  key: CacheKey,
): Promise<AiGenerationRow | undefined> {
  const [row] = await db
    .select()
    .from(aiGenerations)
    .where(
      and(
        eq(aiGenerations.kind, key.kind),
        eq(aiGenerations.targetId, key.targetId),
        eq(aiGenerations.promptVersion, key.promptVersion),
        eq(aiGenerations.model, key.model),
      ),
    );
  return row;
}

/**
 * Drop every cached generation of this kind for this target — the "regenerate"
 * half of regenerate-as-delete-and-generate. Deliberately not scoped to the
 * current prompt version or model: a user asking to regenerate wants this
 * target's stale prose gone, not just the row that happens to match today's key.
 */
export async function deleteCached(
  db: NodePgDatabase,
  kind: AiKind,
  targetId: string,
): Promise<void> {
  await db
    .delete(aiGenerations)
    .where(
      and(eq(aiGenerations.kind, kind), eq(aiGenerations.targetId, targetId)),
    );
}

// One generation in flight per (kind, target). Acquired synchronously — before
// the first await — so two overlapping requests can't both pass the guard and
// pay for the same tokens twice.
const inFlight = new Set<string>();

const lockKey = (kind: AiKind, targetId: string) => `${kind}:${targetId}`;

/**
 * Generate prose and cache it: yields chunks as they arrive, then persists the
 * complete output with its token usage. A failed or abandoned generation
 * persists nothing — a cached error would be served forever.
 *
 * Throws `AiDisabledError` (no key) or `AiInFlightError` (already running)
 * before yielding anything, so routes can map those to a status code.
 */
export function streamGeneration(
  db: NodePgDatabase,
  provider: AiProvider,
  opts: { kind: AiKind; targetId: string; input: string },
): AsyncIterable<string> {
  const { kind, targetId } = opts;
  if (!provider.model) throw new AiDisabledError();

  const key = lockKey(kind, targetId);
  if (inFlight.has(key)) throw new AiInFlightError();
  inFlight.add(key);

  const model = provider.model;
  const { system, version } = loadPrompt(kind);

  async function* run(): AsyncGenerator<string> {
    try {
      const result = provider.stream({
        system,
        prompt: capInput(opts.input),
      });

      let output = "";
      for await (const chunk of result.textStream) {
        output += chunk;
        yield chunk;
      }

      const usage = await result.usage;
      await db
        .insert(aiGenerations)
        .values({
          kind,
          targetId,
          promptVersion: version,
          model,
          output,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
        // A concurrent writer (different process, so the in-memory lock can't
        // see it) may have cached the same key already. Theirs is as good as
        // ours — keep it rather than fail a stream the client already received.
        .onConflictDoNothing();
    } finally {
      inFlight.delete(key);
    }
  }

  return run();
}
