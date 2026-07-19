/**
 * Impact propagation (GP-22) — moved to the shared static-diff package
 * (GP-153) so the VS Code extension's diff mode propagates blast radius with
 * the identical function. This module keeps the backend's historical import
 * path stable.
 */
export { propagateImpact } from "@groundplan/graph-differ";
