import { Check, ChevronsUpDown, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrg } from "@/org/use-org";
import { cn } from "@/lib/utils";

/**
 * The org switcher (GP-117), pinned in the sidebar's user area. It shows the
 * active org and — for a SaaS user in more than one org — the list to switch
 * between them. It also holds the "Organization settings" entry (GP-189) that
 * opens the org-scoped settings page (GP-188) for the current org.
 *
 * In single-org mode there is nothing to switch between, but the popover still
 * exists for that settings entry. It hides only when there is no active org at
 * all (a SaaS account that belongs to nothing yet). Every member may open org
 * settings (org:read is member-level; the page itself hides admin-only
 * controls), so the entry needs no role gate here.
 */
export function OrgSwitcher({
  collapsed = false,
}: Readonly<{
  /** GP-243: on the rail the org is its initial, with its name as a tooltip. */
  collapsed?: boolean;
}>) {
  const { memberships, activeOrg, singleOrg, switchOrg } = useOrg();
  const navigate = useNavigate();

  if (!activeOrg) return null;

  return (
    <div className={cn("border-border border-t p-3", collapsed && "px-2")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={collapsed ? `Organization: ${activeOrg.name}` : undefined}
            title={collapsed ? activeOrg.name : undefined}
            className={cn(
              "hover:bg-accent/60 flex w-full items-center gap-2 rounded-sm py-1.5 text-left transition-colors",
              collapsed ? "justify-center px-0" : "px-2",
            )}
          >
            {collapsed ? (
              <span
                className="border-border text-muted-foreground grid size-7 shrink-0 place-items-center rounded-sm border font-mono text-xs font-semibold uppercase"
                aria-hidden="true"
              >
                {activeOrg.name.slice(0, 1)}
              </span>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground text-[0.7rem] uppercase tracking-wide">
                    Organization
                  </p>
                  <p className="truncate text-sm font-medium">
                    {activeOrg.name}
                  </p>
                </div>
                <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {!singleOrg && (
            <>
              <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {memberships.map((m) => (
                <DropdownMenuItem
                  key={m.organization.id}
                  onSelect={() => switchOrg(m.organization.id)}
                  className="gap-2"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {m.organization.name}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {m.role}
                  </span>
                  {m.organization.id === activeOrg.id && (
                    <Check className="size-4 shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onSelect={() => navigate(`/orgs/${activeOrg.id}/settings`)}
          >
            <Settings />
            Organization settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
