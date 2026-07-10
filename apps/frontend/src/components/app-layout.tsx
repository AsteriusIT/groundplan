import { Outlet } from "react-router-dom";

import { Sidebar } from "./sidebar";

/** The shell every authenticated page lives in: fixed sidebar + gridded canvas. */
export function AppLayout() {
  return (
    <div className="flex h-svh overflow-hidden">
      <Sidebar />
      <main className="blueprint-grid flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
