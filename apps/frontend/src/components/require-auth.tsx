import { type ReactNode, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { useAuth } from "@/auth/use-auth";

/**
 * Gate protected routes. There is no in-app login page: an unauthenticated
 * visitor is sent straight to the OIDC provider (Keycloak) to sign in, and the
 * OIDC `state` carries where they were headed so `/callback` returns them there.
 */
export function RequireAuth({ children }: Readonly<{ children: ReactNode }>) {
  const { isAuthenticated, isLoading, login } = useAuth();
  const location = useLocation();
  const redirecting = useRef(false);

  useEffect(() => {
    if (isLoading || isAuthenticated || redirecting.current) return;
    // Kick off the redirect once; preserve path + query so e.g. an
    // /invite/:token link survives the round-trip.
    redirecting.current = true;
    void login(location.pathname + location.search);
  }, [isLoading, isAuthenticated, login, location.pathname, location.search]);

  if (isAuthenticated) {
    return <>{children}</>;
  }

  return (
    <div className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">
      {isLoading ? "Loading…" : "Redirecting to sign in…"}
    </div>
  );
}
