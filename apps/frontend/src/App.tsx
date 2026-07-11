import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "@/components/app-layout";
import { RequireAuth } from "@/components/require-auth";
import { CallbackPage } from "@/pages/callback-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { LoginPage } from "@/pages/login-page";
import { ProjectDetailPage } from "@/pages/project-detail-page";
import { ProjectsPage } from "@/pages/projects-page";
import { SettingsPage } from "@/pages/settings-page";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/callback" element={<CallbackPage />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

export default App;
