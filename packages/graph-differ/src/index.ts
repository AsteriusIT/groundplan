/**
 * @groundplan/graph-differ — the static-diff producer as a pure shared package
 * (GP-153): `diff(before, after)` annotates the "after" GraphSnapshot with
 * change/ghost/attribute-diff/impact the way the plan flow would. Consumed by
 * the VS Code extension's diff mode; the backend re-exports the impact and
 * attribute-diff logic that moved here.
 */
export * from "./diff.js";
export * from "./canonicalize.js";
export * from "./impact.js";
export * from "./attribute-diff.js";
