import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { assertValidGraph, computeGraphStats } from "../graph/graph.js";
import { parseHclRepo, type HclFile } from "../graph/hcl-parser.js";
import { summarize } from "../graph/summarize.js";

// GP-123: the playground is a paste-and-look tool, not an ingestion path —
// the limits are deliberately far below the CI webhook's.
export const MAX_PLAYGROUND_FILES = 50;
export const MAX_PLAYGROUND_BYTES = 1024 * 1024;
// Raw-body headroom over MAX_PLAYGROUND_BYTES for JSON escaping + envelope.
const PARSE_BODY_LIMIT = 2 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [".tf", ".tfvars"];

export const playgroundFilesSchema = {
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
};

const parseBodySchema = {
  type: "object",
  required: ["files"],
  additionalProperties: false,
  properties: { files: playgroundFilesSchema },
};

/**
 * Enforce the shared playground limits (GP-123/GP-124). Sends the error reply
 * and returns true when the file set is rejected. Count and size get explicit
 * 400/413s (the ticket's contract); per-file problems 422 naming each file.
 */
export function rejectInvalidFiles(
  files: HclFile[],
  reply: FastifyReply,
): boolean {
  if (files.length > MAX_PLAYGROUND_FILES) {
    reply.code(400).send({
      error: "Bad Request",
      message: `too many files (max ${MAX_PLAYGROUND_FILES})`,
    });
    return true;
  }
  const totalBytes = files.reduce(
    (sum, f) => sum + Buffer.byteLength(f.content, "utf8"),
    0,
  );
  if (totalBytes > MAX_PLAYGROUND_BYTES) {
    reply.code(413).send({
      error: "Payload Too Large",
      message: "files exceed 1 MB total",
    });
    return true;
  }
  const fields: { field: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!ALLOWED_EXTENSIONS.some((ext) => file.path.endsWith(ext))) {
      fields.push({
        field: file.path,
        message: "only .tf and .tfvars files are allowed",
      });
    }
    if (seen.has(file.path)) {
      fields.push({ field: file.path, message: "duplicate file path" });
    }
    seen.add(file.path);
  }
  if (fields.length > 0) {
    reply.code(422).send({
      error: "Unprocessable Entity",
      message: "Validation failed",
      fields,
    });
    return true;
  }
  return false;
}

/**
 * GP-123: ephemeral HCL → GraphSnapshot. The parser already works on in-memory
 * `{ path, content }` files, so nothing touches disk and nothing is persisted —
 * the response is the same validate → stats → summarize assembly the docs flow
 * stores, minus the insert (determinism, ADR #3).
 */
export const playgroundRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/playground/parse",
    { bodyLimit: PARSE_BODY_LIMIT, schema: { body: parseBodySchema } },
    async (request, reply) => {
      const { files } = request.body as { files: HclFile[] };
      if (rejectInvalidFiles(files, reply)) return;

      const { graph, warnings, unresolvedReferences } = parseHclRepo(files);

      // A file the scanner had to skip is a parse failure the user must fix —
      // surface it as a 422 naming the file, never as a silently thinner graph.
      const skipped = warnings.flatMap((w) => {
        const match = /^skipped (.+?): (.+)$/.exec(w);
        return match ? [{ field: match[1] ?? "", message: match[2] ?? "" }] : [];
      });
      if (skipped.length > 0) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "HCL parse failed",
          fields: skipped,
        });
      }

      assertValidGraph(graph);
      const stats = {
        ...computeGraphStats(graph),
        warnings,
        ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
      };
      return { graph, stats, summaryMd: summarize(graph) };
    },
  );
};
