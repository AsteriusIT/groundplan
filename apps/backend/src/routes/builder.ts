/**
 * The visual builder's server side (GP-134): a composed BuilderGraph in,
 * Terraform files out.
 *
 * Stateless and deterministic, like `POST /playground/parse` — nothing is
 * stored, nothing is executed, no model is consulted (ADR #3). The generator
 * itself lives in `@groundplan/builder`, so the browser composes against
 * exactly the rules the server generates from; this file is the wire: the
 * flag, the limits, and the shape of a refusal.
 */
import type { FastifyPluginAsync } from "fastify";

import {
  generateTerraform,
  validateBuilderGraph,
  type BuilderGraph,
  type BuilderIssue,
} from "@groundplan/builder";

import { catalogForGraph } from "../services/builder-catalog.js";

// A composition is something a person drew, not an ingestion path — the caps
// are the playground's spirit: far below what a webhook may cost the server.
export const MAX_BUILDER_NODES = 200;
const GENERATE_BODY_LIMIT = 1024 * 1024;

const positionSchema = {
  type: "object",
  required: ["x", "y"],
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" } },
};

const graphSchema = {
  type: "object",
  required: ["nodes"],
  additionalProperties: false,
  properties: {
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "type", "name"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          type: { type: "string", minLength: 1, maxLength: 200 },
          // The Terraform local name is checked properly by the validator,
          // which can say *why* it is wrong; the schema only bounds it.
          name: { type: "string", maxLength: 200 },
          // Deliberately untyped here. An attribute value is a string, a
          // number, a boolean or a list of strings depending on what the
          // catalog says the attribute is — a job for `validateBuilderGraph`,
          // which can answer *which* attribute is wrong and why. Declaring the
          // union in JSON Schema would hand it to Ajv's type coercion, which
          // rewrites the payload to make it fit (a one-element list becomes a
          // string) and turns a valid graph into a puzzling 422. The body
          // limit is what bounds the size.
          attributes: { type: "object" },
          position: positionSchema,
        },
      },
    },
    references: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "to", "attribute"],
        additionalProperties: false,
        properties: {
          from: { type: "string", minLength: 1, maxLength: 200 },
          to: { type: "string", minLength: 1, maxLength: 200 },
          attribute: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  },
};

const generateBodySchema = {
  type: "object",
  required: ["graph"],
  additionalProperties: false,
  properties: { graph: graphSchema },
};

/** What arrives on the wire — positions and attributes are optional there. */
type WireGraph = {
  nodes: {
    id: string;
    type: string;
    name: string;
    attributes?: BuilderGraph["nodes"][number]["attributes"];
    position?: { x: number; y: number };
  }[];
  references?: BuilderGraph["references"];
};

/** Fill in what the wire may omit. Positions are the canvas's, never the code's. */
export function toBuilderGraph(wire: WireGraph): BuilderGraph {
  return {
    nodes: wire.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      attributes: node.attributes ?? {},
      position: node.position ?? { x: 0, y: 0 },
    })),
    references: wire.references ?? [],
  };
}

/**
 * Validation issues → the app-wide 422 `fields` shape. The field names the
 * resource as the user sees it (`azurerm_subnet.app.virtual_network_name`) and
 * `nodeId` rides along, so the canvas can badge the very node without matching
 * on prose.
 */
export function toFields(
  issues: readonly BuilderIssue[],
  graph: BuilderGraph,
): { field: string; message: string; nodeId: string; reason: string }[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return issues.map((issue) => {
    const node = byId.get(issue.nodeId);
    const address = node ? `${node.type}.${node.name}` : issue.nodeId;
    return {
      field: issue.attribute ? `${address}.${issue.attribute}` : address,
      message: issue.message,
      nodeId: issue.nodeId,
      reason: issue.reason,
    };
  });
}

/**
 * Is the builder on? Global (not org-scoped), beside `/ai/status`: it is a
 * readout of server configuration, the same for every tenant, and the frontend
 * reads it to decide whether to render a Build surface at all.
 */
export const builderStatusRoutes: FastifyPluginAsync = async (app) => {
  app.get("/builder/status", async () => ({ enabled: app.builderEnabled }));
};

export const builderRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/builder/generate",
    { bodyLimit: GENERATE_BODY_LIMIT, schema: { body: generateBodySchema } },
    async (request, reply) => {
      // No flag, no surface — the AI layer's convention, so a disabled feature
      // is indistinguishable from one that was never built.
      if (!app.builderEnabled) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "the visual builder is disabled" });
      }

      const { graph: wire } = request.body as { graph: WireGraph };
      if (wire.nodes.length > MAX_BUILDER_NODES) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: `too many resources (max ${MAX_BUILDER_NODES})`,
        });
      }

      const graph = toBuilderGraph(wire);

      // The composition is checked against what the providers themselves say
      // (GP-238), assembled for the types on this canvas alone.
      const { catalog, versions, warming } = await catalogForGraph(graph, {
        repo: app.catalog,
        allowlist: app.catalogAllowlist,
      });
      if (warming.length > 0) {
        // Refusing beats guessing: a graph checked against a catalog we do not
        // have is a graph checked against nothing, and "looks fine" would be
        // the one dishonest answer this endpoint could give.
        return reply.code(503).send({
          error: "Service Unavailable",
          code: "catalog_warming",
          message: `the ${warming.join(", ")} catalog is still being read`,
        });
      }

      const issues = validateBuilderGraph(graph, catalog);
      if (issues.length > 0) {
        // Every offending node, never just the first: the canvas badges them
        // all at once, and nothing is written anywhere.
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "Validation failed",
          fields: toFields(issues, graph),
        });
      }

      return { files: generateTerraform(graph, { catalog, versions }) };
    },
  );
};
