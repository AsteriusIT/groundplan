import { useCallback, useEffect, useState } from "react";

import { ApiError, changeMemberRole, listMembers, removeMember } from "@/api/client";
import type { Member, Role } from "@/api/types";
import { useAuth } from "@/auth/use-auth";
import { useCan } from "@/rbac/use-can";
import { Button } from "@/components/ui/button";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; members: Member[] };

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * The org's member roster with role management (GP-118). Any member sees it;
 * admins can change member↔admin roles and remove people; owners can additionally
 * transfer ownership. The last owner can never be demoted or removed — the UI
 * disables it, and the API enforces it regardless.
 */
export function OrgMembers() {
  const { user } = useAuth();
  const canManage = useCan("member:manage");
  const canTransferOwnership = useCan("ownership:transfer");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ status: "loading" });
    listMembers()
      .then((members) => setState({ status: "ready", members }))
      .catch((err) =>
        setState({
          status: "error",
          message: err instanceof ApiError ? err.message : "Could not load members.",
        }),
      );
  }, []);

  useEffect(() => load(), [load]);

  const patchRole = useCallback(async (userId: string, role: Role) => {
    setActionError(null);
    try {
      const updated = await changeMemberRole(userId, role);
      setState((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              members: prev.members.map((m) =>
                m.userId === userId ? updated : m,
              ),
            }
          : prev,
      );
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Could not change the role.",
      );
    }
  }, []);

  const remove = useCallback(async (userId: string) => {
    setActionError(null);
    try {
      await removeMember(userId);
      setState((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              members: prev.members.filter((m) => m.userId !== userId),
            }
          : prev,
      );
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Could not remove the member.",
      );
    }
  }, []);

  if (state.status === "loading") {
    return <p className="text-muted-foreground text-sm">Loading members…</p>;
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="text-destructive text-sm">
        {state.message}
      </p>
    );
  }

  const owners = state.members.filter((m) => m.role === "owner").length;
  const roleOptions: Role[] = canTransferOwnership
    ? ["owner", "admin", "member"]
    : ["admin", "member"];

  return (
    <div className="space-y-3">
      {actionError && (
        <p role="alert" className="text-destructive text-sm">
          {actionError}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-left text-xs">
            <th className="pb-2 font-medium">Member</th>
            <th className="pb-2 font-medium">Role</th>
            {canManage && <th className="pb-2" />}
          </tr>
        </thead>
        <tbody>
          {state.members.map((m) => {
            const isLastOwner = m.role === "owner" && owners <= 1;
            // An admin cannot touch an owner (that needs ownership transfer).
            const touchable =
              canManage && (m.role !== "owner" || canTransferOwnership);
            const locked = !touchable || isLastOwner;
            return (
              <tr key={m.userId} className="border-border/60 border-b">
                <td className="py-2.5">
                  <div className="font-medium">
                    {m.displayName ?? m.email ?? "Unknown"}
                    {m.userId === user?.id && (
                      <span className="text-muted-foreground"> (you)</span>
                    )}
                  </div>
                  <div className="text-muted-foreground font-mono text-xs">
                    {m.email ?? ""}
                  </div>
                </td>
                <td className="py-2.5">
                  {canManage ? (
                    <select
                      aria-label={`Role for ${m.email ?? m.userId}`}
                      className="border-input bg-background rounded-sm border px-2 py-1 text-sm disabled:opacity-60"
                      value={m.role}
                      disabled={locked}
                      onChange={(e) =>
                        void patchRole(m.userId, e.target.value as Role)
                      }
                    >
                      {/* Keep the current role selectable even if it's owner. */}
                      {[...new Set([m.role, ...roleOptions])].map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{ROLE_LABEL[m.role]}</span>
                  )}
                </td>
                {canManage && (
                  <td className="py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={locked}
                      onClick={() => void remove(m.userId)}
                    >
                      Remove
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
