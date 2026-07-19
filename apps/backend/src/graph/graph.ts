/**
 * The GraphSnapshot graph format — re-exported from the shared package
 * (GP-145). The types, the JSON-Schema validator and the stats helper all
 * live in `@groundplan/graph-parser` now, beside the producer that emits the
 * shape; this module keeps the backend's historical import path stable.
 */
export {
  graphSchema,
  validateGraph,
  InvalidGraphError,
  assertValidGraph,
  computeGraphStats,
  type ValidationResult,
  type ChangeKind,
  type EdgeKind,
  type NsgRule,
  type RoleAssignment,
  type Identity,
  type NodeSource,
  type GraphNode,
  type GraphEdge,
  type Graph,
  type UnresolvedReference,
  type GraphStats,
} from "@groundplan/graph-parser";
