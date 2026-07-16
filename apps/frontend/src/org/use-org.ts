import { useContext } from "react";

import { OrgContext, type OrgContextValue } from "./org-context";

/** Access the active-org context. Throws if used outside an `OrgProvider`. */
export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) {
    throw new Error("useOrg must be used within an OrgProvider");
  }
  return ctx;
}
