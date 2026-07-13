import { Outlet } from "react-router-dom";

import { Sidebar } from "./sidebar";

/**
 * The shell every authenticated page lives in: fixed sidebar + flat canvas.
 * The blueprint grid belongs to the diagram views only (the PR and docs pages
 * opt into it themselves), so list/detail pages stay a plain surface.
 */
export function AppLayout() {
  return (
    <div className="flex h-svh overflow-hidden">
      <Sidebar />
      <main className="bg-background flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
