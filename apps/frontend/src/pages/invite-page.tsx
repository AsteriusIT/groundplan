import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { acceptInvitation, ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/auth/use-auth";
import { useOrg } from "@/org/use-org";

/**
 * Accept-invitation screen (GP-116/GP-117) at `/invite/:token`. It renders behind
 * the auth guard, so a logged-out visitor runs the OIDC flow first and returns
 * here (the guard preserves the path). Accepting joins the org and drops the user
 * into it.
 */
export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { reloadUser } = useAuth();
  const { switchOrg } = useOrg();
  const navigate = useNavigate();

  const [status, setStatus] = useState<"idle" | "joining" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!token) return <Navigate to="/" replace />;

  async function accept() {
    setStatus("joining");
    setError(null);
    try {
      const { organization } = await acceptInvitation(token!);
      await reloadUser();
      switchOrg(organization.id);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not accept this invitation.",
      );
      setStatus("error");
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>You&rsquo;ve been invited</CardTitle>
          <CardDescription>
            Accept to join the organization and start reviewing its
            infrastructure.
          </CardDescription>
        </CardHeader>
        {error && (
          <CardContent>
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          </CardContent>
        )}
        <CardFooter className="gap-2">
          <Button
            onClick={() => void accept()}
            disabled={status === "joining"}
          >
            {status === "joining" ? "Joining…" : "Accept invitation"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => navigate("/", { replace: true })}
            disabled={status === "joining"}
          >
            Not now
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
