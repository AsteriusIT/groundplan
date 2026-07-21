/**
 * The RBAC permission matrix (GP-114/GP-118) — a **verbatim mirror** of the
 * backend's `apps/backend/src/rbac/permissions.ts`. FE and BE gate on the exact
 * same table so they can never disagree (the epic's requirement). If you change
 * one, change the other in the same commit.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

/** Does `role` sit at or above `min` in the hierarchy? */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export const PERMISSIONS = [
  "org:read",
  "project:manage",
  "integration:manage",
  "member:manage",
  "org:manage",
  "org:delete",
  "ownership:transfer",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_MIN_ROLE: Record<Permission, Role> = {
  "org:read": "member",
  "project:manage": "admin",
  // GP-183: manage org-level integrations (Confluence credentials shared across
  // repos). Members may read the list to pick one at repo level.
  "integration:manage": "admin",
  "member:manage": "admin",
  "org:manage": "admin",
  "org:delete": "owner",
  "ownership:transfer": "owner",
};

/** Whether a role holds a permission. */
export function can(role: Role, permission: Permission): boolean {
  return roleAtLeast(role, PERMISSION_MIN_ROLE[permission]);
}
