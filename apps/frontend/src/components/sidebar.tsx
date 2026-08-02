import { NavLink, useLocation } from "react-router-dom";

import { appMode, modeForPath } from "@/lib/app-mode";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { Logo } from "./logo";
import { ModeSwitcher } from "./mode-switcher";
import { OrgSwitcher } from "./org-switcher";
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
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const mode = appMode(modeForPath(pathname));

  return (
    <aside className="bg-card border-border flex h-svh w-[236px] shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <Logo className="size-7" />
        <span className="font-display text-lg font-semibold tracking-tight">
          groundplan
        </span>
      </div>

      <ModeSwitcher />

      {mode.nav.length > 0 && (
        <nav className="flex-1 px-3 py-2" aria-label={mode.label}>
          <p className="text-muted-foreground px-2 pb-2 font-mono text-[10px] font-medium tracking-[0.12em] uppercase">
            Navigation
          </p>
          <ul className="space-y-0.5">
            {mode.nav.map(({ to, label, icon: Icon, tag }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-sm border-l-2 px-2.5 py-2 text-sm transition-colors",
                      isActive
                        ? "border-primary bg-accent text-primary font-medium"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground border-transparent",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {tag && (
                    <Chip variant="accent" className="shrink-0 text-[9px]">
                      {tag}
                    </Chip>
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
      <OrgSwitcher />
      <UserCard />
    </aside>
  );
}
