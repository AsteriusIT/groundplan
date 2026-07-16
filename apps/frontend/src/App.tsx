import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "@/components/app-layout";
import { RequireAuth } from "@/components/require-auth";
import { RequireOrg } from "@/components/require-org";
import { CallbackPage } from "@/pages/callback-page";
import { ClusterPage } from "@/pages/cluster-page";
import { ClustersPage } from "@/pages/clusters-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { DocsPage } from "@/pages/docs-page";
import { InvitePage } from "@/pages/invite-page";
import { OnboardingPage } from "@/pages/onboarding-page";
import { OrgLandingPage } from "@/pages/org-landing-page";
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
      {/* No in-app login page: <RequireAuth> sends unauthenticated visitors
          straight to the OIDC provider. /callback completes the code exchange. */}
      <Route path="/callback" element={<CallbackPage />} />
      {/* Public, no-auth read-only share page (GP-39). */}
      <Route path="/share/:token" element={<SharePage />} />

      {/* Accept an invitation (GP-116). Behind auth: a logged-out visitor runs
          the OIDC flow first and the guard returns them here. */}
      <Route
        path="/invite/:token"
        element={
          <RequireAuth>
            <InvitePage />
          </RequireAuth>
        }
      />
      {/* Create-organization (GP-117), SaaS mode. No org shell yet. */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />
      {/* Shareable per-org deep link (GP-117): switch to :orgSlug, then land. */}
      <Route
        path="/o/:orgSlug"
        element={
          <RequireAuth>
            <OrgLandingPage />
          </RequireAuth>
        }
      />

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
            <RequireOrg>
              <AppLayout />
            </RequireOrg>
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
        {/* Clusters are a top-level place, beside projects rather than inside
            one: a cluster has no PR to review and no commit to document, which is
            all a project is for. */}
        <Route path="/clusters" element={<ClustersPage />} />
        <Route path="/clusters/:id" element={<ClusterPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

export default App;
