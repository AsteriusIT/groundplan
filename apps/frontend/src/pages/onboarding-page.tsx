import { type SyntheticEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { ApiError, createOrganization } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { slugify } from "@/lib/format";
import { useAuth } from "@/auth/use-auth";
import { useOrg } from "@/org/use-org";

/**
 * Create-organization screen (GP-117). A SaaS user with no membership lands here
 * and creates their first org, becoming its owner. Single-org users and anyone
 * who already belongs somewhere are redirected away.
 */
export function OnboardingPage() {
  const { reloadUser } = useAuth();
  const { activeOrg, singleOrg, switchOrg } = useOrg();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (singleOrg || activeOrg) {
    return <Navigate to="/dashboard" replace />;
  }

  const effectiveSlug = slugEdited ? slug : slugify(name);

  async function handleSubmit(event: SyntheticEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const org = await createOrganization({
        name: name.trim(),
        slug: effectiveSlug,
      });
      // Refresh memberships so the new org is known, make it active, and go home.
      await reloadUser();
      switchOrg(org.id);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not create the organization.",
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create your organization</CardTitle>
          <CardDescription>
            An organization is where your projects, repositories and clusters
            live. You&rsquo;ll be its owner.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc."
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-slug">Slug</Label>
              <Input
                id="org-slug"
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value);
                }}
                placeholder="acme"
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                required
              />
              <p className="text-muted-foreground text-xs">
                Used in links. Lowercase letters, numbers and dashes.
              </p>
            </div>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={submitting || name.trim() === "" || effectiveSlug === ""}
              className="w-full"
            >
              {submitting ? "Creating…" : "Create organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
