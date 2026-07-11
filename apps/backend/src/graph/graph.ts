/**
 * The GraphSnapshot graph format (v1) — the central, source-agnostic data
 * structure of the product. Both producers (plan.json parser, HCL parser) emit
 * this shape and everything renders from it.
 *
 * The canonical contract is the committed JSON Schema
 * (`schema/graph.v1.schema.json`); the TypeScript types below mirror it and the
 * Ajv validator enforces it at runtime before anything is stored.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv, type ValidateFunction } from "ajv";

import type { AttributeDiffRow } from "./attribute-diff.js";

export type ChangeKind = "create" | "update" | "delete" | "noop";
export type EdgeKind = "depends_on" | "contains";

export type GraphNode = {
  /** Terraform address, e.g. `module.payments.aws_ecs_service.this`. */
  id: string;
  name: string;
  /** Resource type (`aws_ecs_service`) or `"module"` for synthetic nodes. */
  type: string;
  /** Provider name (`aws`); null for module nodes. */
  provider: string | null;
  /** Module names from the root down to this node's parent module. */
  module_path: string[];
  /** Planned action; null for snapshots not derived from a plan. */
  change: ChangeKind | null;
  /** v2: an unchanged node that (transitively) depends on a changed one (GP-22). */
  impacted?: boolean;
  /** v2: hop distance to the nearest changed node (1 = direct dependent). */
  impact_distance?: number;
  /**
   * v3: masked per-attribute before/after diff for a changed node (GP-32).
   * Sensitive values are `(sensitive)`; nested changes collapse to `{…}`.
   */
  attribute_diff?: AttributeDiffRow[];
  /** v3: true when the changed-attribute list exceeded 20 and was capped. */
  attribute_diff_truncated?: boolean;
};

export type GraphEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  /**
   * For `depends_on` edges: true when derived from an expression reference
   * (GP-20/GP-21), false when declared with an explicit `depends_on`. Omitted
   * for `contains` edges.
   */
  inferred?: boolean;
};

export type Graph = {
  /**
   * 1 = docs (hcl) snapshots; 2 adds optional node impact fields (GP-22);
   * 3 adds optional node attribute-diff fields (GP-32). All stay valid.
   */
  version: 1 | 2 | 3;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphStats = {
  nodes: number;
  edges: number;
  /** How many of the `depends_on` edges were expression-inferred (GP-20). */
  inferredEdges: number;
  /** How many unchanged nodes are impacted by the change set (GP-22). */
  impactedCount: number;
  changes: {
    create: number;
    update: number;
    delete: number;
    noop: number;
    /** Nodes with a null `change` (module nodes, docs-flow snapshots). */
    unchanged: number;
  };
};

// The schema lives at the package root (`schema/`) so it survives the tsc build
// unchanged — two levels up from this module in both `src/graph` and
// `dist/graph` layouts (same trick as db/migrate.ts and the `drizzle/` folder).
const schemaPath = fileURLToPath(
  new URL("../../schema/graph.v1.schema.json", import.meta.url),
);

/** The frozen v1 graph JSON Schema, parsed from the committed file. */
export const graphSchema: Record<string, unknown> = JSON.parse(
  readFileSync(schemaPath, "utf8"),
) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true });
const validator: ValidateFunction = ajv.compile(graphSchema);

export type ValidationResult = { valid: boolean; errors: string[] };

/** Validate a value against the v1 graph schema. Never throws. */
export function validateGraph(graph: unknown): ValidationResult {
  const valid = validator(graph);
  if (valid) return { valid: true, errors: [] };
  const errors = (validator.errors ?? []).map(
    (e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim(),
  );
  return { valid: false, errors };
}

/** Thrown when a graph fails schema validation before storage. */
export class InvalidGraphError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid graph: ${errors.join("; ")}`);
    this.name = "InvalidGraphError";
    this.errors = errors;
  }
}

/** Validate and narrow to `Graph`, throwing `InvalidGraphError` if malformed. */
export function assertValidGraph(graph: unknown): asserts graph is Graph {
  const { valid, errors } = validateGraph(graph);
  if (!valid) throw new InvalidGraphError(errors);
}

/** Node/edge/change counts, computed once and stored alongside the snapshot. */
export function computeGraphStats(graph: Graph): GraphStats {
  const changes = { create: 0, update: 0, delete: 0, noop: 0, unchanged: 0 };
  for (const node of graph.nodes) {
    if (node.change === null) changes.unchanged += 1;
    else changes[node.change] += 1;
  }
  const inferredEdges = graph.edges.filter((e) => e.inferred === true).length;
  const impactedCount = graph.nodes.filter((n) => n.impacted === true).length;
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    inferredEdges,
    impactedCount,
    changes,
  };
}
