import { useEffect } from "react";

import { PageHeader } from "@/components/page-header";
import { AccountCard, AppearanceCard } from "@/components/settings-sections";

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
  // A hash on arrival scrolls to its section (jsdom's scrollIntoView is a
  // test-setup no-op).
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, []);

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
