import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "@/components/app-layout";
import { RequireAuth } from "@/components/require-auth";
import { CallbackPage } from "@/pages/callback-page";
import { ClusterPage } from "@/pages/cluster-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { DocsPage } from "@/pages/docs-page";
import { LoginPage } from "@/pages/login-page";
import { ProjectDetailPage } from "@/pages/project-detail-page";
import { ProjectsPage } from "@/pages/projects-page";
import { PullDetailPage } from "@/pages/pull-detail-page";
import { PullsPage } from "@/pages/pulls-page";
import { SettingsPage } from "@/pages/settings-page";
import { SharePage } from "@/pages/share-page";

// Dev-only design-system reference (GP-28). Lazy + DEV-gated so the styleguide
// chunk never ships in the production bundle.
const StyleguidePage = import.meta.env.DEV
  ? lazy(() =>
      import("@/pages/styleguide-page").then((m) => ({
        default: m.StyleguidePage,
      })),
    )
  : null;

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/callback" element={<CallbackPage />} />
      {/* Public, no-auth read-only share page (GP-39). */}
      <Route path="/share/:token" element={<SharePage />} />

      {StyleguidePage && (
        <Route
          path="/styleguide"
          element={
            <Suspense fallback={null}>
              <StyleguidePage />
            </Suspense>
          }
        />
      )}

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route
          path="/projects/:id/repos/:repoId/pulls"
          element={<PullsPage />}
        />
        <Route
          path="/projects/:id/repos/:repoId/pulls/:number"
          element={<PullDetailPage />}
        />
        <Route
          path="/projects/:id/repos/:repoId/docs"
          element={<DocsPage />}
        />
        {/* The Kubernetes view (GP-99). Nested under its project like the docs
            and PR views — a cluster belongs to a project, and the sidebar is for
            the top-level places, not for every diagram you can reach. */}
        <Route
          path="/projects/:id/clusters/:clusterId"
          element={<ClusterPage />}
        />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

export default App;
