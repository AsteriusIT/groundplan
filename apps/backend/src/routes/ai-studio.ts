/**
 * GP-137: the AI Infrastructure Studio's chat endpoint.
 *
 * A stateless streaming turn: the client owns the session (conversation
 * history + the current `.tf` file set) and sends all of it every time. The
 * model answers with a short assistant message and — through the single
 * `write_files` tool — the complete regenerated project. Full regeneration
 * every turn; no diffs, no DB writes, nothing cached.
 *
 * The response is the AI SDK's UI-message stream (SSE), which `useChat`
 * consumes natively. Provider failures surface as typed `error` events in the
 * stream, never as a bare 500.
 */
import { Readable } from "node:stream";
import type { FastifyPluginAsync } from "fastify";
import {
  JsonToSseTransformStream,
  jsonSchema,
  streamText,
  tool,
  toUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type ModelMessage,
} from "ai";

import { parse, type Diagnostic, type HclFile } from "@groundplan/graph-parser";

import { assertValidGraph } from "../graph/graph.js";
import { lintGraph, type LintFinding } from "../graph/hcl-lint.js";
import { loadStudioPrompt } from "../services/ai.js";

/** One in-memory `.tf` file of the studio session. */
export type StudioFile = { path: string; content: string };

/** One turn of the client-owned conversation history (prose only). */
export type StudioMessage = { role: "user" | "assistant"; text: string };

// Guardrails (GP-137): a studio session is a conversation, not an ingestion
// path. The turn cap bounds the tokens a runaway session can spend; the size
// cap bounds what we are willing to send back to the model as context.
export const MAX_STUDIO_MESSAGES = 40;
export const MAX_STUDIO_FILES = 50;
export const MAX_STUDIO_HCL_BYTES = 256 * 1024;

const chatBodySchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["role", "text"],
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          text: { type: "string", maxLength: 20_000 },
        },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
          content: { type: "string" },
        },
      },
    },
  },
};

/**
 * The single structured output (GP-137): the complete regenerated project.
 * No `execute` on purpose — the tool call *is* the result; the client reads
 * the file set straight from the tool part of the streamed message.
 */
export const writeFilesTool = tool({
  description:
    "Return the complete Terraform project: every .tf file, full content. " +
    "Always the whole file set — a file you omit is a file you deleted.",
  inputSchema: jsonSchema<{ files: StudioFile[] }>({
    type: "object",
    required: ["files"],
    additionalProperties: false,
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "content"],
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
      },
    },
  }),
});

/** A provider failure in one actionable line (mirrors routes/ai.ts). */
function providerMessage(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  return err.message.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

/** The current file set, rendered as a context turn the model regenerates from. */
function filesContext(files: StudioFile[]): string {
  const rendered = files
    .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
    .join("\n\n");
  return `Current Terraform project files (regenerate from these):\n\n${rendered}`;
}

/**
 * History + current files → model messages. The file context rides as its own
 * user turn just before the latest request, so the model always regenerates
 * from the files as they are now — not as an earlier turn described them.
 */
export function toModelMessages(
  messages: StudioMessage[],
  files: StudioFile[],
): ModelMessage[] {
  const turns: ModelMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.text,
  }));
  if (files.length > 0) {
    turns.splice(-1, 0, { role: "user", content: filesContext(files) });
  }
  return turns;
}

const parseBodySchema = {
  type: "object",
  required: ["files"],
  additionalProperties: false,
  properties: {
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["path", "content"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
          content: { type: "string" },
        },
      },
    },
  },
};

/**
 * What the studio's parse answers with beside the snapshot (GP-138/GP-139):
 * `parse` is what the parser could not read or resolve; `lint` is what the
 * deterministic best-practices rules found in what it could.
 */
export type StudioDiagnostics = {
  parse: Diagnostic[];
  lint: LintFinding[];
};

export const aiStudioRoutes: FastifyPluginAsync = async (app) => {
  // GP-138: ephemeral in-memory `.tf` files → GraphSnapshot, through the same
  // Producer B the docs flow uses (`parse`, GP-145) — so an AI-generated
  // project renders exactly as it would once committed to a repository.
  // Synchronous, stateless, nothing stored.
  app.post(
    "/ai-studio/parse",
    { schema: { body: parseBodySchema } },
    async (request, reply) => {
      const { files } = request.body as { files: HclFile[] };

      if (files.length > MAX_STUDIO_FILES) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: `too many files (max ${MAX_STUDIO_FILES})`,
        });
      }
      const totalBytes = files.reduce(
        (sum, f) => sum + Buffer.byteLength(f.content, "utf8"),
        0,
      );
      if (totalBytes > MAX_STUDIO_HCL_BYTES) {
        return reply.code(413).send({
          error: "Payload Too Large",
          message: `the project exceeds ${MAX_STUDIO_HCL_BYTES / 1024} KB of HCL`,
        });
      }
      const wrongType = files.filter(
        (f) => !f.path.endsWith(".tf") && !f.path.endsWith(".tfvars"),
      );
      if (wrongType.length > 0) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "Validation failed",
          diagnostics: wrongType.map((f) => ({
            severity: "error",
            file: f.path,
            message: "only .tf and .tfvars files are parsed",
          })),
        });
      }
      if (!files.some((f) => f.path.endsWith(".tf"))) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "no .tf files to parse",
          diagnostics: [],
        });
      }

      const { snapshot, diagnostics } = parse(files);

      // Nothing drawable at all is a failed generation, and the diagnostics
      // are the reason. A *partially* valid set instead answers 200: the valid
      // files' graph plus error diagnostics naming the rest — the UI shows
      // what it can and says why the rest is missing.
      const errors = diagnostics.filter((d) => d.severity === "error");
      if (snapshot.nodes.length === 0 && errors.length > 0) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "HCL parse failed",
          diagnostics,
        });
      }

      assertValidGraph(snapshot);
      const result: StudioDiagnostics = {
        parse: diagnostics,
        // GP-139: the best-practices pass rides the same response — one round
        // trip, and the findings anchor to node ids the canvas can badge.
        lint: lintGraph(snapshot),
      };
      return { snapshot, diagnostics: result };
    },
  );

  app.post(
    "/ai-studio/chat",
    { schema: { body: chatBodySchema } },
    async (request, reply) => {
      // Same convention as the rest of the AI layer: no key, no surface.
      if (!app.studioModel) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "the AI layer is disabled" });
      }

      const { messages, files = [] } = request.body as {
        messages: StudioMessage[];
        files?: StudioFile[];
      };

      if (messages.length > MAX_STUDIO_MESSAGES) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: `this session is too long (max ${MAX_STUDIO_MESSAGES} messages) — start a new one`,
        });
      }
      if (messages.at(-1)?.role !== "user") {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "the last message must be from the user",
        });
      }
      if (files.length > MAX_STUDIO_FILES) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: `too many files (max ${MAX_STUDIO_FILES})`,
        });
      }
      const totalBytes = files.reduce(
        (sum, f) => sum + Buffer.byteLength(f.content, "utf8"),
        0,
      );
      if (totalBytes > MAX_STUDIO_HCL_BYTES) {
        return reply.code(413).send({
          error: "Payload Too Large",
          message: `the project exceeds ${MAX_STUDIO_HCL_BYTES / 1024} KB of HCL`,
        });
      }

      const result = streamText({
        model: app.studioModel,
        system: loadStudioPrompt().system,
        messages: toModelMessages(messages, files),
        tools: { write_files: writeFilesTool },
      });

      // The UI-message chunk stream, SSE-encoded by hand rather than via
      // `pipeUIMessageStreamToResponse`: sending through Fastify's reply keeps
      // its lifecycle (onSend hooks, logging) intact. Provider errors become
      // in-stream `error` parts — by the time they can happen, the 200 and the
      // first bytes may already be gone, so in-band is the only honest channel.
      const stream = toUIMessageStream({
        stream: result.stream,
        onError: (err) => {
          request.log.error({ err }, "AI studio chat failed");
          return `the AI provider failed: ${providerMessage(err)}`;
        },
      }).pipeThrough(new JsonToSseTransformStream());

      return reply
        .headers(UI_MESSAGE_STREAM_HEADERS)
        .send(Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]));
    },
  );
};
