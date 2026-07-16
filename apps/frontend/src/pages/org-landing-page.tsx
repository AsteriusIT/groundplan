import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";

import { useOrg } from "@/org/use-org";

/**
 * Deep-link entry at `/o/:orgSlug` (GP-117): makes that org active — if the user
 * belongs to it — then lands on the dashboard. This is what makes a link to
 * another of your orgs shareable. An unknown/foreign slug just falls through to
 * the current org's dashboard.
 */
export function OrgLandingPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { memberships, activeOrg, switchOrg } = useOrg();

  const match = memberships.find((m) => m.organization.slug === orgSlug);

  useEffect(() => {
    if (match && activeOrg?.id !== match.organization.id) {
      switchOrg(match.organization.id);
    }
  }, [match, activeOrg, switchOrg]);

  if (!match) return <Navigate to="/dashboard" replace />;
  // Wait until the switch has taken effect so the dashboard's first fetch already
  // targets the right org.
  if (activeOrg?.id !== match.organization.id) {
    return (
      <main className="text-muted-foreground grid min-h-svh place-items-center">
        Switching organization…
      </main>
    );
  }
  return <Navigate to="/dashboard" replace />;
}
