import { Check, ChevronsUpDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrg } from "@/org/use-org";

/**
 * The org switcher (GP-117), pinned in the sidebar's user area. Hidden entirely
 * in single-org mode, where there is only ever the one org. Switching sets the
 * active org; the shell remounts its content so the new org's data loads.
 */
export function OrgSwitcher() {
  const { memberships, activeOrg, singleOrg, switchOrg } = useOrg();

  if (singleOrg || !activeOrg) return null;

  return (
    <div className="border-border border-t p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="hover:bg-accent/60 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors"
          >
            <div className="min-w-0 flex-1">
              <p className="text-muted-foreground text-[0.7rem] uppercase tracking-wide">
                Organization
              </p>
              <p className="truncate text-sm font-medium">{activeOrg.name}</p>
            </div>
            <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
