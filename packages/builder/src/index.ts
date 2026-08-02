/**
 * @groundplan/builder — the visual builder's shared core (GP-131): the resource
 * catalog, the BuilderGraph document, its validation and deterministic HCL
 * generation. Pure and dependency-free, so the browser composes against exactly
 * the rules the server generates from.
 *
 * One-way by construction (ADR #5): everything here goes from a composed graph
 * to Terraform. Nothing reads Terraform back.
 */
export * from "./builder-graph.js";
export * from "./catalog.js";
export * from "./containment.js";
export * from "./provider-schema.js";
export * from "./provider-schema-parse.js";
export * from "./schema-def.js";
export * from "./validate.js";
export * from "./generate.js";
