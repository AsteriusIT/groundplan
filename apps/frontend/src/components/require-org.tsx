import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useOrg } from "@/org/use-org";

/**
 * Guards the authenticated shell (GP-117): a user with no active org — a SaaS
 * account that belongs to nothing yet — is sent to create one. Single-org users
 * always have the default org, so they never hit this.
 */
export function RequireOrg({ children }: Readonly<{ children: ReactNode }>) {
  const { activeOrg } = useOrg();
  if (!activeOrg) {
    return <Navigate to="/onboarding" replace />;
  }
  return <>{children}</>;
}
