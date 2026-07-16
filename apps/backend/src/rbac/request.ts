/**
 * Request-level RBAC helpers (GP-114). The org-scope guard sets `request.membership`
 * for every `/orgs/:orgId/...` route; handlers read it through these helpers to
 * gate writes. Kept apart from `plugins/org-scope` so route files can import the
 * helpers without a circular dependency on the plugin that registers them.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

import { can, type Permission, type Role } from "./permissions.js";

export type Membership = { orgId: string; role: Role };

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The caller's membership of the org named in the URL, set by the org-scope
     * guard. Undefined outside an org-scoped route. In auth-disabled dev/test the
     * guard grants `owner` so existing route tests keep working.
     */
    membership?: Membership;
  }
}

/** The org id the current org-scoped request targets. */
export function orgIdOf(request: FastifyRequest): string {
  const id = request.membership?.orgId;
  if (!id) throw new Error("orgIdOf() used outside an org-scoped route");
  return id;
}

/**
 * Enforce a permission for the current org-scoped request. Returns true when the
 * caller may proceed; otherwise sends 403 and returns false (the handler must
 * then return immediately). The guard has already 404'd non-members, so a 403
 * here means "you belong to this org, but your role is too low".
 */
export function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): boolean {
  const role = request.membership?.role;
  if (!role || !can(role, permission)) {
    reply
      .code(403)
      .send({ error: "Forbidden", message: `requires permission: ${permission}` });
    return false;
  }
  return true;
}
