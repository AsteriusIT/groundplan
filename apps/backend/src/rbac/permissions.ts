/**
 * The RBAC permission matrix (GP-114) — the single source of truth for "who can
 * do what" in an organization. It is deliberately **framework-free** (no Fastify,
 * no Drizzle) so the frontend can mirror it verbatim (`apps/frontend/src/rbac/
 * permissions.ts`): FE and BE gate on the exact same table and can never
 * disagree. If you change this file, change the mirror in the same commit.
 *
 * Roles form a strict hierarchy — `owner > admin > member` — so a permission is
 * expressed as the *minimum* role that holds it, and everyone above inherits it.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Higher rank = more authority. `owner` outranks `admin` outranks `member`. */
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

/** Does `role` sit at or above `min` in the hierarchy? */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * The permissions the app gates on. Grouped by the epic's matrix:
 *   - member: read all org resources (+ trigger docs/AI generation, which is a
 *     read-shaped action gated by `org:read`).
 *   - admin:  + create/edit/delete projects, repos & clusters, manage PATs,
 *     manage members & invitations (incl. member↔admin role changes).
 *   - owner:  + org settings/rename, delete org, transfer ownership.
 */
export const PERMISSIONS = [
  "org:read",
  "project:manage",
  "member:manage",
  "org:manage",
  "org:delete",
  "ownership:transfer",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The minimum role that holds each permission. */
export const PERMISSION_MIN_ROLE: Record<Permission, Role> = {
  "org:read": "member",
  "project:manage": "admin",
  "member:manage": "admin",
  "org:manage": "admin",
  "org:delete": "owner",
  "ownership:transfer": "owner",
};

/** Whether a role holds a permission. */
export function can(role: Role, permission: Permission): boolean {
  return roleAtLeast(role, PERMISSION_MIN_ROLE[permission]);
}
