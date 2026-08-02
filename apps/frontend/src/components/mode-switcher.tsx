import { Check, ChevronsUpDown } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Chip } from "@/components/ui/chip";
import { availableModes, appMode, modeForPath } from "@/lib/app-mode";
import { useAiStatus } from "@/lib/use-ai-status";
import { cn } from "@/lib/utils";

/**
 * The mode switcher (GP-242): which of the four jobs the application is doing,
 * chosen immediately after the logo — the org switcher's pattern one level up,
 * because "which organization" and "which mode" are the two questions that
 * change what every other control means.
 *
 * The active mode is read from the URL (`modeForPath`), never stored: a deep
 * link, a refresh and the back button all agree without anything to keep in
 * sync. Selecting a mode navigates to its root.
 */
export function ModeSwitcher({
  collapsed = false,
}: Readonly<{
  /** GP-243: the rail shows the mode's icon alone, with its name as a tooltip. */
  collapsed?: boolean;
}>) {
  const ai = useAiStatus();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeId = modeForPath(pathname);
  const modes = availableModes(ai?.enabled === true);
  // While the AI probe is in flight the switcher still lists the modes that do
  // not depend on it, so the shell never renders an empty control. A mode the
  // deployment does not offer is not the active one either — a stale AI link
  // reads as Documentation, which is where `modeForPath` sends the unclaimed.
  const active = modes.some((m) => m.id === activeId)
    ? appMode(activeId)
    : appMode("docs");
  const ActiveIcon = active.icon;

  return (
    <div className={cn("px-3 pb-2", collapsed && "px-2")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Mode: ${active.label}`}
            title={collapsed ? active.label : undefined}
            className={cn(
              "border-border hover:bg-accent/60 flex w-full items-center gap-2 rounded-sm border px-2 py-1.5 text-left transition-colors",
              collapsed && "justify-center px-0",
            )}
          >
            <ActiveIcon className="text-muted-foreground size-4 shrink-0" />
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground font-mono text-[10px] tracking-[0.12em] uppercase">
                    Mode
                  </p>
                  <p className="truncate text-sm font-medium">{active.label}</p>
                </div>
                <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Switch mode</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {modes.map((mode) => {
            const Icon = mode.icon;
            return (
              <DropdownMenuItem
                key={mode.id}
                onSelect={() => navigate(mode.root)}
                aria-current={mode.id === active.id ? "true" : undefined}
                className="items-start gap-2"
              >
                <Icon className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {mode.label}
                    </span>
                    {mode.tag && (
                      <Chip variant="accent" className="shrink-0 text-[9px]">
                        {mode.tag}
                      </Chip>
                    )}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {mode.description}
                  </span>
                </span>
                {mode.id === active.id && (
                  <Check className="mt-0.5 size-4 shrink-0" />
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
