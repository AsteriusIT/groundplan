import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";

import {
  annotations,
  repositories,
  toPublicAnnotation,
  type AnnotationRow,
} from "../db/schema.js";
import { isTerraformAddress } from "../lib/tf-address.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const anchorsSchema = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 500 },
  minItems: 1,
  maxItems: 50,
};

const createAnnotationSchema = {
  type: "object",
  required: ["type", "anchors"],
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["note", "link", "group"] },
    anchors: anchorsSchema,
    label: { type: "string", minLength: 1, maxLength: 200 },
    body: { type: "string", maxLength: 50000 },
  },
};

const updateAnnotationSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    anchors: anchorsSchema,
    label: { type: "string", minLength: 1, maxLength: 200 },
    body: { type: "string", maxLength: 50000 },
  },
};

type AnnotationType = "note" | "link" | "group";

/**
 * Enforce the per-type shape rules (ADR #4 / GP-56). Anchors are validated for
 * *format* only — existence is reconciliation's job (GP-57). Returns a clear
 * message on the first violation, or null when the annotation is well-formed.
 */
function validateAnnotation(
  type: AnnotationType,
  anchors: string[],
  label: string | null,
  body: string | null,
): string | null {
  for (const anchor of anchors) {
    if (!isTerraformAddress(anchor)) {
      return `anchor '${anchor}' is not a valid Terraform address`;
    }
  }
  if (type === "note" && anchors.length !== 1) {
    return "note annotations must have exactly 1 anchor";
  }
  if (type === "link" && anchors.length !== 2) {
    return "link annotations must have exactly 2 anchors";
  }
  if (type === "group" && anchors.length < 2) {
    return "group annotations must have at least 2 anchors";
  }
  if ((type === "link" || type === "group") && !label) {
    return `${type} annotations require a label`;
  }
  if (type !== "note" && body != null && body !== "") {
    return "only note annotations can have a body";
  }
  return null;
}

export const annotationRoutes: FastifyPluginAsync = async (app) => {
  // List a repository's annotations (the layer alongside — never inside — the
  // snapshot).
  app.get(
    "/repositories/:id/annotations",
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
      const rows = await app.db
        .select()
        .from(annotations)
        .where(eq(annotations.repositoryId, id))
        .orderBy(desc(annotations.createdAt));
      return rows.map(toPublicAnnotation);
    },
  );

  app.post(
    "/repositories/:id/annotations",
    { schema: { params: idParamsSchema, body: createAnnotationSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        type: AnnotationType;
        anchors: string[];
        label?: string;
        body?: string;
      };

      const [repo] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, id));
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      const label = body.label ?? null;
      const noteBody = body.body ?? null;
      const invalid = validateAnnotation(body.type, body.anchors, label, noteBody);
      if (invalid) {
        return reply
          .code(422)
          .send({ error: "Unprocessable Entity", message: invalid });
      }

      const [row] = await app.db
        .insert(annotations)
        .values({
          repositoryId: id,
          type: body.type,
          anchors: body.anchors,
          label,
          body: noteBody,
          createdBy: request.authUser?.id ?? null,
        })
        .returning();

      return reply.code(201).send(toPublicAnnotation(row as AnnotationRow));
    },
  );

  app.get(
    "/annotations/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [row] = await app.db
        .select()
        .from(annotations)
        .where(eq(annotations.id, id));
      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "annotation not found" });
      }
      return toPublicAnnotation(row);
    },
  );

  app.patch(
    "/annotations/:id",
    { schema: { params: idParamsSchema, body: updateAnnotationSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        anchors?: string[];
        label?: string;
        body?: string;
      };

      const [existing] = await app.db
        .select()
        .from(annotations)
        .where(eq(annotations.id, id));
      if (!existing) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "annotation not found" });
      }

      // Merge the patch over the current row, then re-validate the whole thing —
      // the type is immutable, so a note can never become a two-anchor link.
      const anchors = body.anchors ?? existing.anchors;
      const label = body.label !== undefined ? body.label : existing.label;
      const noteBody = body.body !== undefined ? body.body : existing.body;
      const invalid = validateAnnotation(existing.type, anchors, label, noteBody);
      if (invalid) {
        return reply
          .code(422)
          .send({ error: "Unprocessable Entity", message: invalid });
      }

      const [row] = await app.db
        .update(annotations)
        .set({ anchors, label, body: noteBody, updatedAt: new Date() })
        .where(eq(annotations.id, id))
        .returning();
      return toPublicAnnotation(row as AnnotationRow);
    },
  );

  app.delete(
    "/annotations/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(annotations)
        .where(eq(annotations.id, id))
        .returning({ id: annotations.id });
      if (deleted.length === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "annotation not found" });
      }
      return reply.code(204).send();
    },
  );
};
