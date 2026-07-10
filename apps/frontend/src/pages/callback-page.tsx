import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/auth/use-auth";

/** Completes the OIDC code exchange, then returns the user to their page. */
export function CallbackPage() {
  const { handleCallback } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // guard against StrictMode double-invoke
    started.current = true;

    handleCallback()
      .then((returnTo) => navigate(returnTo, { replace: true }))
      .catch(() => navigate("/login", { replace: true }));
  }, [handleCallback, navigate]);

  return (
    <main className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">
      Signing you in…
    </main>
  );
}
