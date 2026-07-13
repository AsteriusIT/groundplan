import type { FastifyPluginAsync } from "fastify";
import { desc, eq } from "drizzle-orm";

import {
  annotations,
  graphSnapshots,
  repositories,
  toPublicAnnotation,
  type AnnotationRow,
} from "../db/schema.js";
import { isTerraformAddress } from "../lib/tf-address.js";
import { reconcileAnnotations } from "../services/annotation-reconcile.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const UUID_RE = new RegExp(UUID_PATTERN);

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

const ANNOTATION_TYPES = ["note", "link", "group", "hide", "rename"] as const;

const createAnnotationSchema = {
  type: "object",
  required: ["type", "anchors"],
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ANNOTATION_TYPES },
    anchors: anchorsSchema,
    label: { type: "string", minLength: 1, maxLength: 200 },
    body: { type: "string", maxLength: 50000 },
    parentGroupId: { type: "string", pattern: UUID_PATTERN },
    createdFromSha: { type: "string", minLength: 1, maxLength: 100 },
    // `provenance` is deliberately absent: only the proposer (GP-75) writes AI
    // annotations, and it does so in-process. A client cannot claim to be a model.
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
    // Accepting a proposal is a status PATCH — the *only* way one goes live.
    // `orphaned` is not settable: reconciliation owns it.
    status: { type: "string", enum: ["resolved"] },
    parentGroupId: { type: ["string", "null"], pattern: UUID_PATTERN },
  },
};

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["resolved", "orphaned", "proposed"] },
    /** Resolve anchors against this snapshot instead of the stored verdict. */
    snapshotId: { type: "string", pattern: UUID_PATTERN },
  },
};

type AnnotationType = (typeof ANNOTATION_TYPES)[number];

type AnnotationShape = {
  type: AnnotationType;
  anchors: string[];
  label: string | null;
  body: string | null;
};

/** What a well-formed annotation of each type looks like (ADR #4 / GP-71). */
type TypeRule = {
  /** Exact anchor count, or a floor when the type takes a variable number. */
  anchors: { exactly: number } | { atLeast: number };
  label: "required" | "optional" | "forbidden";
  /** Only a note carries prose. */
  body: boolean;
};

const RULES: Record<AnnotationType, TypeRule> = {
  note: { anchors: { exactly: 1 }, label: "optional", body: true },
  // The logical edge: two endpoints, and the label ("replicates to") is a
  // nicety, not a requirement — you may just want to say *that* they are joined.
  link: { anchors: { exactly: 2 }, label: "optional", body: false },
  group: { anchors: { atLeast: 1 }, label: "required", body: false },
  hide: { anchors: { exactly: 1 }, label: "forbidden", body: false },
  rename: { anchors: { exactly: 1 }, label: "required", body: false },
};

/** The anchor-count rule, as a message a human can act on. */
function checkAnchorCount(type: AnnotationType, count: number): string | null {
  const rule = RULES[type].anchors;
  if ("exactly" in rule) {
    if (count === rule.exactly) return null;
    const plural = rule.exactly === 1 ? "anchor" : "anchors";
    return `${type} annotations must have exactly ${rule.exactly} ${plural}`;
  }
  if (count >= rule.atLeast) return null;
  return `${type} annotations must have at least ${rule.atLeast} anchor`;
}

function checkLabel(type: AnnotationType, label: string | null): string | null {
  const rule = RULES[type].label;
  if (rule === "required" && !label) return `${type} annotations require a label`;
  if (rule === "forbidden" && label) return `${type} annotations cannot have a label`;
  return null;
}

/**
 * Enforce the per-type shape rules (ADR #4 / GP-56, five types as of GP-71).
 * Anchors are validated for *format* only — existence is reconciliation's job
 * (GP-57). Returns a clear message on the first violation, or null when the
 * annotation is well-formed.
 *
 * A `link` (the epic's logical edge) is the one type whose anchors may be UUIDs:
 * an edge can join two groups, and a group is an annotation, not an address.
 */
function validateAnnotation({
  type,
  anchors,
  label,
  body,
}: AnnotationShape): string | null {
  for (const anchor of anchors) {
    const ok =
      isTerraformAddress(anchor) || (type === "link" && UUID_RE.test(anchor));
    if (!ok) {
      return type === "link"
        ? `anchor '${anchor}' is neither a Terraform address nor a group id`
        : `anchor '${anchor}' is not a valid Terraform address`;
    }
  }

  const hasBody = body != null && body !== "";
  return (
    checkAnchorCount(type, anchors.length) ??
    checkLabel(type, label) ??
    (hasBody && !RULES[type].body ? "only note annotations can have a body" : null)
  );
}

export const annotationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Validate a group's parent link: groups nest exactly one level, and only
   * within their own repository. Returns an error message, or null when the
   * nesting is legal (including the "no parent" case).
   */
  async function validateParentGroup(
    repositoryId: string,
    selfId: string | null,
    parentGroupId: string | null,
    type: AnnotationType,
  ): Promise<string | null> {
    if (parentGroupId === null) return null;
    if (type !== "group") return "only group annotations can nest in a group";
    if (parentGroupId === selfId) return "a group cannot be its own parent";

    const [parent] = await app.db
      .select()
      .from(annotations)
      .where(eq(annotations.id, parentGroupId));
    if (parent?.repositoryId !== repositoryId) {
      return "parent group not found in this repository";
    }
    if (parent.type !== "group") return "parentGroupId must reference a group";
    // One level max: the parent may not itself be nested. Two systems deep and
    // the C4 mapping (top-level = system, child = container) stops meaning anything.
    if (parent.parentGroupId !== null) {
      return "groups nest one level — the parent group is already nested";
    }
    return null;
  }

  // List a repository's annotations (the layer alongside — never inside — the
  // snapshot). `?status=` filters; `?snapshotId=` re-resolves the anchors against
  // that snapshot on the fly, so the caller sees what *would* orphan without
  // waiting for the next generation to write it down.
  app.get(
    "/repositories/:id/annotations",
    { schema: { params: idParamsSchema, querystring: listQuerySchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { status?: string; snapshotId?: string };

      const [repo] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, id));
      if (!repo) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "repository not found" });
      }

      let rows = await app.db
        .select()
        .from(annotations)
        .where(eq(annotations.repositoryId, id))
        .orderBy(desc(annotations.createdAt));

      if (query.snapshotId) {
        const [snapshot] = await app.db
          .select({
            graph: graphSnapshots.graph,
            repositoryId: graphSnapshots.repositoryId,
          })
          .from(graphSnapshots)
          .where(eq(graphSnapshots.id, query.snapshotId));
        if (!snapshot || snapshot.repositoryId !== id) {
          return reply
            .code(404)
            .send({ error: "Not Found", message: "snapshot not found" });
        }
        // A read-only re-resolution: the verdict is computed, not persisted.
        // Writing it down is snapshot generation's job (GP-57), not a GET's.
        const verdicts = new Map(
          reconcileAnnotations(rows, snapshot.graph).map((r) => [r.id, r]),
        );
        rows = rows.map((row) => {
          const verdict = verdicts.get(row.id);
          return verdict
            ? { ...row, status: verdict.status, missingAnchors: verdict.missingAnchors }
            : row;
        });
      }

      const filtered = query.status
        ? rows.filter((row) => row.status === query.status)
        : rows;
      return filtered.map(toPublicAnnotation);
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
        parentGroupId?: string;
        createdFromSha?: string;
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
      const parentGroupId = body.parentGroupId ?? null;

      const invalid =
        validateAnnotation({ type: body.type, anchors: body.anchors, label, body: noteBody }) ??
        (await validateParentGroup(id, null, parentGroupId, body.type));
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
          parentGroupId,
          createdFromSha: body.createdFromSha ?? null,
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
        status?: "resolved";
        parentGroupId?: string | null;
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
      const label = body.label ?? existing.label;
      const noteBody = body.body ?? existing.body;
      // `null` is meaningful here — it un-nests a group — so `??` would be wrong.
      const parentGroupId =
        body.parentGroupId !== undefined ? body.parentGroupId : existing.parentGroupId;

      const invalid =
        validateAnnotation({ type: existing.type, anchors, label, body: noteBody }) ??
        (await validateParentGroup(
          existing.repositoryId,
          existing.id,
          parentGroupId,
          existing.type,
        ));
      if (invalid) {
        return reply
          .code(422)
          .send({ error: "Unprocessable Entity", message: invalid });
      }

      const [row] = await app.db
        .update(annotations)
        .set({
          anchors,
          label,
          body: noteBody,
          parentGroupId,
          // Accepting a proposal (GP-76) is this, and only this. An accepted
          // annotation keeps its `ai` provenance — the badge is permanent.
          ...(body.status ? { status: body.status, missingAnchors: [] } : {}),
          updatedAt: new Date(),
        })
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
