import { ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/auth/use-auth";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The pinned user card (GP-186): the avatar/name/email row at the foot of the
 * sidebar is the trigger for a small account menu — Settings (personal
 * settings, GP-187) and Sign out. The standalone sign-out icon is gone; the
 * action lives in the menu. Since "Settings" left the primary NAV, the card
 * also carries its active-route treatment.
 */
export function UserCard() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");

  return (
    <div className="border-border border-t p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-current={onSettings ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left transition-colors",
              onSettings
                ? "bg-accent text-foreground"
                : "hover:bg-accent/60",
            )}
          >
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
            <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[210px]">
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void logout()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
