/**
 * @groundplan/graph-parser — Producer B (static HCL → GraphSnapshot) as a
 * pure, dependency-light shared package (GP-145). Consumed by the backend
 * (docs snapshots of main, the playground) and the VS Code extension host.
 */
export * from "./parse.js";
export * from "./graph.js";
export * from "./hcl-parser.js";
export * from "./dependency-edges.js";
export * from "./azurerm-joins.js";
export * from "./containment.js";
export * from "./iam.js";
export * from "./nsg.js";
