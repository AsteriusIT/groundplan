import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { setActiveOrgProvider } from "@/api/client";
import type { Membership } from "@/api/types";
import { useAuth } from "@/auth/use-auth";

import { OrgContext, type ActiveOrg, type OrgContextValue } from "./org-context";

const STORAGE_KEY = "groundplan.activeOrgId";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function toActive(m: Membership): ActiveOrg {
  return {
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    role: m.role,
  };
}

/**
 * Provides the active org (GP-117). Memberships come from `GET /me`; the active
 * one is remembered in localStorage and resolved against the current memberships
 * (falling back to the first when the stored id is stale). It also wires the API
 * client so every org-scoped call targets `/orgs/:activeOrgId/...`.
 */
export function OrgProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { user } = useAuth();
  const memberships = useMemo<Membership[]>(
    () => user?.memberships ?? [],
    [user],
  );
  const singleOrg = user?.singleOrg ?? true;

  const [activeOrgId, setActiveOrgId] = useState<string | null>(readStored);

  const activeOrg = useMemo<ActiveOrg | null>(() => {
    const chosen =
      memberships.find((m) => m.organization.id === activeOrgId) ??
      memberships[0];
    return chosen ? toActive(chosen) : null;
  }, [memberships, activeOrgId]);

  // The client reads the active org id lazily at request time. Keep a ref current
  // each render so a page's fetch (which fires before this provider's effects)
  // already sees the right org; register the reader once.
  const activeRef = useRef<string | null>(activeOrg?.id ?? null);
  activeRef.current = activeOrg?.id ?? null;
  useMemo(() => setActiveOrgProvider(() => activeRef.current), []);

  const switchOrg = useCallback((orgId: string) => {
    setActiveOrgId(orgId);
    try {
      localStorage.setItem(STORAGE_KEY, orgId);
    } catch {
      // A blocked localStorage still switches for this session.
    }
  }, []);

  const value = useMemo<OrgContextValue>(
    () => ({ memberships, activeOrg, singleOrg, switchOrg }),
    [memberships, activeOrg, singleOrg, switchOrg],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
