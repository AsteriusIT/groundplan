import { BookOpen, ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/auth/use-auth";
import { docsUrl } from "@/lib/docs";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The pinned user card (GP-186): the avatar/name/email row at the foot of the
 * sidebar is the trigger for a small account menu — Settings (personal
 * settings, GP-187) and Sign out. The standalone sign-out icon is gone; the
 * action lives in the menu. Since "Settings" left the primary NAV, the card
 * also carries its active-route treatment.
 */
export function UserCard({
  collapsed = false,
}: Readonly<{
  /** GP-243: on the rail the card is its avatar; the menu behind it is the same. */
  collapsed?: boolean;
}>) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const who = user?.display_name ?? "Signed in";

  return (
    <div className={cn("border-border border-t p-3", collapsed && "px-2")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-current={onSettings ? "page" : undefined}
            aria-label={collapsed ? who : undefined}
            title={collapsed ? who : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-sm py-1.5 text-left transition-colors",
              collapsed ? "justify-center px-0" : "px-2",
              onSettings
                ? "bg-accent text-foreground"
                : "hover:bg-accent/60",
            )}
          >
            <div
              className={cn(
                "bg-primary text-primary-foreground grid shrink-0 place-items-center rounded-sm font-mono text-xs font-semibold",
                collapsed ? "size-7" : "size-9",
              )}
              aria-hidden="true"
            >
              {initials(user?.display_name ?? null, user?.email ?? null)}
            </div>
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{who}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {user?.email ?? ""}
                  </p>
                </div>
                <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[210px]">
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          {/* The one always-available way in. Everywhere else the app links to a
              specific page, beside the thing somebody is stuck on — this is for
              the reader who does not yet know what they are looking for. */}
          <DropdownMenuItem asChild>
            <a href={docsUrl("home")} target="_blank" rel="noreferrer">
              <BookOpen />
              Documentation
            </a>
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
