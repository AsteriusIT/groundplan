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

/**
 * v4: one NSG security rule (GP-43). Values are raw as written in the source;
 * only `ports` is normalized (`"80"`, `"80-443"`, `"*"`).
 */
export type NsgRule = {
  name: string;
  priority: number;
  direction: string; // Inbound | Outbound (raw)
  access: string; // Allow | Deny (raw)
  protocol: string; // raw
  ports: string; // "80" | "80-443" | "*"
  source: string; // raw source address prefix
  destination: string; // raw destination address prefix
};

/**
 * v4: an Azure role assignment payload (GP-47), on `azurerm_role_assignment`
 * nodes. `principal`/`scope` are resolved Terraform addresses when they
 * reference another resource in the snapshot, otherwise the raw id/string.
 */
export type RoleAssignment = {
  /** role_definition_name (e.g. "Owner", "AcrPull"), or role_definition_id. */
  role: string;
  /** Resolved address of the granted identity, or the raw principal object id. */
  principal: string;
  /** Resolved address of the scope, or the raw Azure scope id. */
  scope: string;
  /** Azure principal type ("ServicePrincipal" | "User" | "Group" | …), if declared. */
  principal_type?: string;
};

/**
 * v4: a managed-identity payload (GP-47), on `azurerm_user_assigned_identity`
 * nodes and on any resource that declares an `identity {}` block.
 */
export type Identity = {
  /** "SystemAssigned" | "UserAssigned" | "SystemAssigned, UserAssigned". */
  type: string;
  /** Resolved addresses of the user-assigned identities this resource uses. */
  identity_ids?: string[];
};

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
  /**
   * v4: id of the node that contains this one (vnet⊃subnet⊃resource). Absent
   * when no single unambiguous parent resolves. Distinct from module `contains`
   * edges — this is network containment (GP-42).
   */
  parent_id?: string;
  /** v4: security rules on an azurerm_network_security_group node (GP-43). */
  rules?: NsgRule[];
  /** v4: true iff this NSG has an inbound Allow rule from an internet source. */
  internet_exposed?: boolean;
  /** v4: node ids of the subnets/NICs this NSG is associated with (GP-43/45). */
  associated_ids?: string[];
  /** v4: role-assignment payload on an azurerm_role_assignment node (GP-47). */
  role_assignment?: RoleAssignment;
  /** v4: true iff this role assignment is a broad-scope high-privilege grant (GP-47). */
  privileged?: boolean;
  /** v4: managed-identity payload — UAI nodes & resources with identity{} (GP-47). */
  identity?: Identity;
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
   * 3 adds optional node attribute-diff fields (GP-32); 4 adds optional node
   * parent_id containment + NSG payload (GP-42/GP-43) + IAM payload (GP-47).
   * All stay valid — every version bump is additive/optional.
   */
  version: 1 | 2 | 3 | 4;
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
