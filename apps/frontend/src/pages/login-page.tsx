import { Navigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/use-auth";

export function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth();

  if (!isLoading && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">groundplan</h1>
        <p className="text-muted-foreground max-w-sm text-balance">
          Sign in to see your infrastructure.
        </p>
      </div>
      <Button onClick={() => void login("/")} disabled={isLoading}>
        Sign in
      </Button>
    </main>
  );
}
