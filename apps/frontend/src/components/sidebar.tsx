import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import { appMode, modeForPath } from "@/lib/app-mode";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { Logo } from "./logo";
import { ModeSwitcher } from "./mode-switcher";
import { OrgSwitcher } from "./org-switcher";
import { useSidebarPrefs } from "./sidebar-prefs";
import { UserCard } from "./user-card";

/**
 * The sidebar is navigation *within* a mode (GP-242). Documentation, Playground,
 * AI Studio and Kubernetes Clusters left it for the switcher beside the logo —
 * they are four different jobs, not five siblings in one list — and what stays
 * here is whatever the active mode contains: dashboards and projects while
 * reviewing code, the two Playground views while sketching, nothing at all in a
 * mode that is one place.
 *
 * Policies sits with Dashboard and Projects rather than in Settings: it is the
 * standard the whole estate is graded against, not a knob for configuring the
 * workspace.
 *
 * It folds to a logo-only rail (GP-243). Everything stays reachable when it
 * does — the same controls, icon-only, with their names as tooltips — because a
 * collapsed sidebar is a narrower sidebar, not a smaller product.
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const mode = appMode(modeForPath(pathname));
  const { collapsed, toggle } = useSidebarPrefs();

  return (
    <aside
      className={cn(
        "bg-card border-border flex h-svh shrink-0 flex-col border-r transition-[width] duration-200",
        collapsed ? "w-14" : "w-[236px]",
      )}
      // The width animates, so the canvas beside it learns its new size when
      // the animation lands rather than a frame after the click. React Flow
      // watches its own box; this is for everything that watches the window.
      onTransitionEnd={(event) => {
        if (event.propertyName === "width") {
          window.dispatchEvent(new Event("resize"));
        }
      }}
    >
      <div
        className={cn(
          "flex items-center gap-2.5 py-4",
          collapsed ? "flex-col px-2" : "px-4",
        )}
      >
        <Logo className="size-7" />
        {!collapsed && (
          <span className="font-display flex-1 truncate text-lg font-semibold tracking-tight">
            groundplan
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`}
          className="text-muted-foreground hover:bg-accent/60 hover:text-foreground grid size-7 shrink-0 place-items-center rounded-sm transition-colors"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      <ModeSwitcher collapsed={collapsed} />

      {mode.nav.length > 0 && (
        <nav
          className={cn("flex-1 py-2", collapsed ? "px-2" : "px-3")}
          aria-label={mode.label}
        >
          {!collapsed && (
            <p className="text-muted-foreground px-2 pb-2 font-mono text-[10px] font-medium tracking-[0.12em] uppercase">
              Navigation
            </p>
          )}
          <ul className="space-y-0.5">
            {mode.nav.map(({ to, label, icon: Icon, tag }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  title={collapsed ? label : undefined}
                  aria-label={collapsed ? label : undefined}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-sm border-l-2 py-2 text-sm transition-colors",
                      collapsed ? "justify-center px-0" : "px-2.5",
                      isActive
                        ? "border-primary bg-accent text-primary font-medium"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground border-transparent",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {tag && (
                        <Chip variant="accent" className="shrink-0 text-[9px]">
                          {tag}
                        </Chip>
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {/* A mode that is one place keeps the switcher and the user area apart. */}
      {mode.nav.length === 0 && <div className="flex-1" />}

      {/* The theme picker lives in Settings only — the sidebar is navigation. */}
      <OrgSwitcher collapsed={collapsed} />
      <UserCard collapsed={collapsed} />
    </aside>
  );
}
