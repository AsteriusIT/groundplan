import { Outlet } from "react-router-dom";

import { useOrg } from "@/org/use-org";
import { FocusModeProvider, useFocusMode } from "./focus-mode";
import { Sidebar } from "./sidebar";

/**
 * The shell every authenticated page lives in: fixed sidebar + flat canvas.
 * The blueprint grid belongs to the diagram views only (the PR and docs pages
 * opt into it themselves), so list/detail pages stay a plain surface.
 *
 * The sidebar folds away in fullscreen mode, which is why the focus state is
 * owned here rather than by the pages that toggle it.
 */
export function AppLayout() {
  return (
    <FocusModeProvider>
      <Shell />
    </FocusModeProvider>
  );
}

function Shell() {
  const { focus } = useFocusMode();
  const { activeOrg } = useOrg();
  return (
    <div className="flex h-svh overflow-hidden">
      {!focus && <Sidebar />}
      <main className="bg-background flex-1 overflow-y-auto">
        {/* Keyed on the active org so switching orgs remounts the page and it
            refetches against the newly selected org (GP-117). */}
        <Outlet key={activeOrg?.id ?? "none"} />
      </main>
    </div>
  );
}
