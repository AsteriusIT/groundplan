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

export const aiStudioRoutes: FastifyPluginAsync = async (app) => {
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
