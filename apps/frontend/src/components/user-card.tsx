import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/use-auth";
import { initials } from "@/lib/format";

export function UserCard() {
  const { user, logout } = useAuth();

  return (
    <div className="flex items-center gap-3 border-t border-border p-3">
      <div
        className="bg-primary text-primary-foreground grid size-9 shrink-0 place-items-center rounded-sm font-mono text-xs font-semibold"
        aria-hidden="true"
      >
        {initials(user?.display_name ?? null, user?.email ?? null)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {user?.display_name ?? "Signed in"}
        </p>
        <p className="text-muted-foreground truncate font-mono text-xs">
          {user?.email ?? ""}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void logout()}
        aria-label="Sign out"
      >
        <LogOut />
      </Button>
    </div>
  );
}
