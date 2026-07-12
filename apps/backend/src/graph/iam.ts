/**
 * IAM payload derivation (GP-47): the role-assignment triple, the managed
 * identity payload, and the computed `privileged` flag. Extraction differs by
 * producer (structured plan `after` vs. HCL text), but the privilege heuristic
 * and the attach step are shared here so both producers agree.
 */
import type { GraphNode, Identity, RoleAssignment } from "./graph.js";

/** The three named broad roles; "*Admin*" is handled by the substring check. */
const HIGH_PRIVILEGE_ROLES = new Set([
  "owner",
  "contributor",
  "user access administrator",
]);

/**
 * The role side of the heuristic (GP-47): Owner / Contributor / User Access
 * Administrator, or any role whose name contains "admin". Case-insensitive.
 */
export function isHighPrivilegeRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return HIGH_PRIVILEGE_ROLES.has(r) || r.includes("admin");
}

/**
 * The scope side of the heuristic (GP-47): a whole subscription or resource
 * group, not anything narrower. A resolved reference wins (we check the scope
 * node's type); a raw Azure id falls back to its shape (no `/providers/` tail).
 */
export function isBroadScope(
  scope: string,
  typeById: ReadonlyMap<string, string>,
): boolean {
  const resolvedType = typeById.get(scope);
  if (resolvedType !== undefined) {
    return (
      resolvedType === "azurerm_resource_group" ||
      resolvedType === "azurerm_subscription"
    );
  }
  const s = scope.trim();
  // /subscriptions/<id>  — subscription scope.
  if (/^\/subscriptions\/[^/]+\/?$/i.test(s)) return true;
  // /subscriptions/<id>/resourceGroups/<name>  — resource-group scope, no narrower tail.
  if (/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/?$/i.test(s)) return true;
  return false;
}

/** Per-node IAM data keyed by node id, produced by a parser. */
export type ExtractedIam = {
  role?: RoleAssignment;
  identity?: Identity;
};

/**
 * Attach `role_assignment` + `privileged` and `identity` payloads to the
 * matching nodes. `privileged` is the shared heuristic — a high-privilege role
 * at subscription/resource-group scope — computed against the full node-type
 * map so a resolved scope reference can be classified. Mutates in place.
 */
export function attachIam(
  nodes: GraphNode[],
  extracted: ReadonlyMap<string, ExtractedIam>,
): void {
  const typeById = new Map(nodes.map((n) => [n.id, n.type]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, data] of extracted) {
    const node = byId.get(id);
    if (!node) continue;
    if (data.role) {
      node.role_assignment = data.role;
      node.privileged =
        isHighPrivilegeRole(data.role.role) &&
        isBroadScope(data.role.scope, typeById);
    }
    if (data.identity) node.identity = data.identity;
  }
}
