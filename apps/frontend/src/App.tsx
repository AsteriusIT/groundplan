import { Navigate, Route, Routes } from "react-router-dom";

import { RequireAuth } from "@/components/require-auth";
import { CallbackPage } from "@/pages/callback-page";
import { HomePage } from "@/pages/home-page";
import { LoginPage } from "@/pages/login-page";

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/callback" element={<CallbackPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
