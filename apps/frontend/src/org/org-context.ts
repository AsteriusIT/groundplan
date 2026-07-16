import { createContext } from "react";

import type { Membership, Role } from "@/api/types";

/** The org the app is currently acting within (GP-117). */
export interface ActiveOrg {
  id: string;
  name: string;
  slug: string;
  /** The caller's role in this org — what `useCan` gates on. */
  role: Role;
}

export interface OrgContextValue {
  /** Every org the user belongs to (from GET /me). */
  memberships: Membership[];
  /** The active org, or null (a SaaS user who belongs to nothing yet). */
  activeOrg: ActiveOrg | null;
  /** Deployment mode — the switcher and create-org flow are hidden when true. */
  singleOrg: boolean;
  /** Make another org (that the user belongs to) the active one. */
  switchOrg: (orgId: string) => void;
}

export const OrgContext = createContext<OrgContextValue | null>(null);
