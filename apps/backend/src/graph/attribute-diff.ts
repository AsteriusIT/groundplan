/**
 * GP-32 attribute diff — moved to the shared static-diff package (GP-153),
 * where the plan flow, the manifest comparison (GP-103) and the VS Code
 * extension's static diff share one masking/truncation policy. This module
 * keeps the backend's historical import path stable.
 */
export {
  computeAttributeDiff,
  render,
  type PlanResourceChange,
} from "@groundplan/graph-differ";

// The row type moved to the shared package with the rest of the graph types
// (GP-145); re-exported here so existing importers keep working.
export type { AttributeDiffRow } from "@groundplan/graph-parser";
