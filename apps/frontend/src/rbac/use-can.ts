import { useOrg } from "@/org/use-org";

import { can, type Permission } from "./permissions";

/**
 * Whether the caller may do something in the active org (GP-118), gated on the
 * same permission matrix the backend enforces. False when there is no active org.
 * Use it to hide/disable UI — never as the only guard, since the API re-checks.
 */
export function useCan(permission: Permission): boolean {
  const { activeOrg } = useOrg();
  return activeOrg ? can(activeOrg.role, permission) : false;
}
