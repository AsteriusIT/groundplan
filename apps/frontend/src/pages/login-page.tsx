import { Navigate, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/use-auth";

export function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth();
  const location = useLocation();
  // Where the guard bounced us from (e.g. an /invite/:token link), so the OIDC
  // round-trip returns there instead of the dashboard.
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (!isLoading && isAuthenticated) {
    return <Navigate to={from} replace />;
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">groundplan</h1>
        <p className="text-muted-foreground max-w-sm text-balance">
          Sign in to see your infrastructure.
        </p>
      </div>
      <Button onClick={() => void login(from)} disabled={isLoading}>
        Sign in
      </Button>
    </main>
  );
}
