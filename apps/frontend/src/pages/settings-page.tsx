import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useOrg } from "@/org/use-org";
import { PageHeader } from "@/components/page-header";
import { AccountCard, AppearanceCard } from "@/components/settings-sections";

/**
 * Legacy `/settings#section` anchors for the sections that moved to the org
 * page (GP-188/GP-190). Keys are the anchors old links and bookmarks used;
 * values are the anchor on `/orgs/:orgId/settings`. Personal anchors (account,
 * appearance) are deliberately absent — those stay here. "danger" and the
 * ticket's "danger-zone" both resolve to the danger section.
 */
const MOVED_ANCHORS: Record<string, string> = {
  members: "members",
  integrations: "integrations",
  invitations: "invitations",
  "ci-token": "ci-token",
  ai: "ai",
  danger: "danger",
  "danger-zone": "danger",
};

/**
 * Personal settings (GP-187): the two sections every user owns regardless of
 * org role — Account (identity from the token, sign out) and Appearance (theme,
 * tour style, panel width; device-local). Organization and workspace controls
 * live on the org-scoped page now (GP-188), so nothing here fetches org data.
 *
 * Two sections don't warrant the grouped section rail the combined page carried
 * — the cards simply stack. The #account / #appearance anchors still resolve
 * for any remaining deep link.
 */
export function SettingsPage() {
  const { activeOrg } = useOrg();
  const navigate = useNavigate();

  // Keep old deep links working after the split (GP-190): an anchor for a
  // moved section redirects to the same anchor on the current org's settings
  // page (the active org is already resolved to last-active-or-first). A
  // personal anchor stays and scrolls (jsdom's scrollIntoView is a no-op).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const moved = MOVED_ANCHORS[hash];
    if (moved && activeOrg) {
      navigate(`/orgs/${activeOrg.id}/settings#${moved}`, { replace: true });
      return;
    }
    document.getElementById(hash)?.scrollIntoView();
  }, [activeOrg, navigate]);

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Your identity and the look of the canvas."
      />
      <div className="mx-auto max-w-3xl space-y-4 px-8 py-8">
        <div id="account" className="scroll-mt-6">
          <AccountCard />
        </div>
        <div id="appearance" className="scroll-mt-6">
          <AppearanceCard />
        </div>
      </div>
    </div>
  );
}
