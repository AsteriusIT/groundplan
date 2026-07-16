import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";

import {
  ApiError,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from "@/api/client";
import type { CreatedInvitation, Invitation } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; invitations: Invitation[] };

/** The invite's shareable link: the server's if it built one, else same-origin. */
function inviteLink(created: CreatedInvitation): string {
  if (created.url) return created.url;
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/invite/${created.token}`;
}

/**
 * Pending invitations for the active org (GP-118), admin+ only. Create a
 * role-scoped invite, copy its link (no SMTP — you send it yourself), and revoke
 * pending ones. Rendered only where the caller can manage members.
 */
export function OrgInvites() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [role, setRole] = useState<"admin" | "member">("member");
  const [email, setEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLink, setLastLink] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    listInvitations()
      .then((invitations) => setState({ status: "ready", invitations }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof ApiError ? err.message : "Could not load invitations.",
        }),
      );
  }, []);

  useEffect(() => load(), [load]);

  async function create(event: SyntheticEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const created = await createInvitation({
        role,
        email: email.trim() || undefined,
      });
      setLastLink(inviteLink(created));
      setEmail("");
      setState((prev) =>
        prev.status === "ready"
          ? { status: "ready", invitations: [created, ...prev.invitations] }
          : prev,
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create the invite.",
      );
    } finally {
      setCreating(false);
    }
  }

  const revoke = useCallback(async (id: string) => {
    await revokeInvitation(id);
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            invitations: prev.invitations.filter((i) => i.id !== id),
          }
        : prev,
    );
  }, []);

  function copy(link: string) {
    void navigator.clipboard?.writeText(link);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            className="border-input bg-background rounded-sm border px-2 py-1.5 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="invite-email">Email (optional)</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
          />
        </div>
        <Button type="submit" disabled={creating}>
          {creating ? "Creating…" : "Create invite"}
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {lastLink && (
        <div className="bg-muted/40 flex items-center gap-2 rounded-sm border border-border p-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">
            {lastLink}
          </code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copy(lastLink)}
            aria-label="Copy invite link"
          >
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
      )}

      {state.status === "ready" && state.invitations.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-xs">
              <th className="pb-2 font-medium">Invitee</th>
              <th className="pb-2 font-medium">Role</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {state.invitations.map((inv) => (
              <tr key={inv.id} className="border-border/60 border-b">
                <td className="py-2 font-mono text-xs">
                  {inv.email ?? "(link only)"}
                </td>
                <td className="py-2 capitalize">{inv.role}</td>
                <td className="py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void revoke(inv.id)}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
