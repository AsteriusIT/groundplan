import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";

import { playgroundDrafts } from "../db/schema.js";
import { parseHclRepo, type HclFile } from "@groundplan/graph-parser";

import { assertValidGraph, computeGraphStats } from "../graph/graph.js";
import type { UnresolvedReference } from "../graph/graph.js";
import { mapK8sObjects } from "../graph/k8s-mapper.js";
import { parseManifests } from "../graph/manifest-parser.js";
import { summarize } from "../graph/summarize.js";

// GP-123: the playground is a paste-and-look tool, not an ingestion path —
// the limits are deliberately far below the CI webhook's.
export const MAX_PLAYGROUND_FILES = 50;
export const MAX_PLAYGROUND_BYTES = 1024 * 1024;
// Raw-body headroom over MAX_PLAYGROUND_BYTES for JSON escaping + envelope.
const PARSE_BODY_LIMIT = 2 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [".tf", ".tfvars", ".yaml", ".yml"];

/** Which stack the parse reads — the playground's mirror of `repositories.iac_type` (GP-101). */
export type PlaygroundIacType = "terraform" | "kubernetes";

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
  properties: {
    files: playgroundFilesSchema,
    iacType: { type: "string", enum: ["terraform", "kubernetes"] },
  },
};

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const draftParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const createDraftSchema = {
  type: "object",
  required: ["name", "files"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    files: playgroundFilesSchema,
  },
};

// A rename sends only `name`; a save sends `files` (a full replacement — the
// draft has no per-file patch semantics, GP-124).
const updateDraftSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    files: playgroundFilesSchema,
  },
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
        message: "only .tf, .tfvars, .yaml and .yml files are allowed",
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

/** `skipped <path>: <why>` warnings → the 422 `fields` shape, naming each file. */
function skippedFields(
  warnings: string[],
): { field: string; message: string }[] {
  return warnings.flatMap((w) => {
    const match = /^skipped (.+?): (.+)$/.exec(w);
    return match ? [{ field: match[1] ?? "", message: match[2] ?? "" }] : [];
  });
}

/**
 * The Terraform producer: the original GP-123 body. `parseHclRepo` selects the
 * `.tf` subset itself, so a mixed set simply leaves its manifests unread.
 */
function parseTerraform(files: HclFile[], reply: FastifyReply) {
  if (!files.some((f) => f.path.endsWith(".tf"))) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "no .tf files to parse",
    });
  }
  const { graph, warnings, unresolvedReferences } = parseHclRepo(files);

  // A file the scanner had to skip is a parse failure the user must fix —
  // surface it as a 422 naming the file, never as a silently thinner graph.
  const skipped = skippedFields(warnings);
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
}

/**
 * The Kubernetes producer: the repo-docs pipeline (GP-102), minus the clone and
 * the insert — parse the YAML subset, map the objects, answer ephemerally.
 */
function parseKubernetes(files: HclFile[], reply: FastifyReply) {
  if (!files.some((f) => f.path.endsWith(".yaml") || f.path.endsWith(".yml"))) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "no .yaml manifests to parse",
    });
  }
  const result = parseManifests(files);

  // In a repository walk an unreadable file is just a file; here the user
  // pasted it, so it is theirs to fix — the HCL branch's exact rule.
  const skipped = skippedFields(result.warnings);
  if (skipped.length > 0) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "YAML parse failed",
      fields: skipped,
    });
  }
  if (result.objects.length === 0) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "no Kubernetes objects found in the .yaml files",
    });
  }

  const unresolved: UnresolvedReference[] = [];
  const graph = mapK8sObjects(result.objects, { unresolved });
  assertValidGraph(graph);
  const stats = {
    ...computeGraphStats(graph),
    warnings: result.warnings,
    skippedDocuments: result.skippedDocuments,
    skippedFiles: result.skippedFiles,
    ...(unresolved.length > 0 ? { unresolvedReferences: unresolved } : {}),
  };
  return { graph, stats, summaryMd: summarize(graph) };
}

/** The authenticated user, or a 401 (defensive — the hook guards this). */
function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = request.authUser;
  if (!user) {
    reply
      .code(401)
      .send({ error: "Unauthorized", message: "not authenticated" });
    return null;
  }
  return user;
}

/**
 * GP-123: ephemeral files → GraphSnapshot. Both parsers already work on
 * in-memory `{ path, content }` files, so nothing touches disk and nothing is
 * persisted — the response is the same validate → stats → summarize assembly
 * the docs flow stores, minus the insert (determinism, ADR #3).
 */
export const playgroundRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/playground/parse",
    { bodyLimit: PARSE_BODY_LIMIT, schema: { body: parseBodySchema } },
    async (request, reply) => {
      const { files, iacType = "terraform" } = request.body as {
        files: HclFile[];
        iacType?: PlaygroundIacType;
      };
      if (rejectInvalidFiles(files, reply)) return;
      // Both parsers select their own subset of the set (`.tf` / `.yaml`), the
      // way the repo-docs producers do (GP-101) — but a mode with nothing to
      // parse is a 422, never a silently empty diagram.
      return iacType === "kubernetes"
        ? parseKubernetes(files, reply)
        : parseTerraform(files, reply);
    },
  );

  // ---- Drafts (GP-124): user-scoped CRUD over the HCL sources ------------

  app.post(
    "/playground/drafts",
    { bodyLimit: PARSE_BODY_LIMIT, schema: { body: createDraftSchema } },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;
      const { name, files } = request.body as {
        name: string;
        files: HclFile[];
      };
      // Same limits as parse — a draft is the parse endpoint's future input.
      // The HCL itself is NOT validated: a draft may hold files that don't
      // parse; validity is checked at parse time, not at save time.
      if (rejectInvalidFiles(files, reply)) return;
      const [row] = await app.db
        .insert(playgroundDrafts)
        .values({ userId: user.id, name, files })
        .returning();
      return reply.code(201).send(row);
    },
  );

  app.get("/playground/drafts", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    // id, name, updatedAt and a count — never the file contents (GP-124).
    return app.db
      .select({
        id: playgroundDrafts.id,
        name: playgroundDrafts.name,
        updatedAt: playgroundDrafts.updatedAt,
        fileCount: sql<number>`jsonb_array_length(${playgroundDrafts.files})`,
      })
      .from(playgroundDrafts)
      .where(eq(playgroundDrafts.userId, user.id))
      .orderBy(desc(playgroundDrafts.updatedAt));
  });

  app.get(
    "/playground/drafts/:id",
    { schema: { params: draftParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;
      const { id } = request.params as { id: string };
      const [row] = await app.db
        .select()
        .from(playgroundDrafts)
        .where(
          and(eq(playgroundDrafts.id, id), eq(playgroundDrafts.userId, user.id)),
        );
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "draft not found" });
      }
      return row;
    },
  );

  app.put(
    "/playground/drafts/:id",
    {
      bodyLimit: PARSE_BODY_LIMIT,
      schema: { params: draftParamsSchema, body: updateDraftSchema },
    },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;
      const { id } = request.params as { id: string };
      const { name, files } = request.body as {
        name?: string;
        files?: HclFile[];
      };
      if (files && rejectInvalidFiles(files, reply)) return;
      const [row] = await app.db
        .update(playgroundDrafts)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(files !== undefined ? { files } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(playgroundDrafts.id, id), eq(playgroundDrafts.userId, user.id)),
        )
        .returning();
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "draft not found" });
      }
      return row;
    },
  );

  app.delete(
    "/playground/drafts/:id",
    { schema: { params: draftParamsSchema } },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;
      const { id } = request.params as { id: string };
      const [row] = await app.db
        .delete(playgroundDrafts)
        .where(
          and(eq(playgroundDrafts.id, id), eq(playgroundDrafts.userId, user.id)),
        )
        .returning({ id: playgroundDrafts.id });
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "draft not found" });
      }
      return reply.code(204).send();
    },
  );
};
