import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";
import { Boxes, LayoutDashboard, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { ThemeSwitcher } from "./theme-switcher";
import { UserCard } from "./user-card";

type NavEntry = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const NAV: NavEntry[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/projects", label: "Projects", icon: Boxes },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="bg-card flex h-svh w-[236px] shrink-0 flex-col border-r border-border">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <Logo className="text-primary size-7" />
        <span className="font-display text-lg font-semibold tracking-tight">
          groundplan
        </span>
      </div>

      <nav className="flex-1 px-3 py-2" aria-label="Primary">
        <p className="text-muted-foreground px-2 pb-2 font-mono text-[10px] font-medium tracking-[0.12em] uppercase">
          Navigation
        </p>
        <ul className="space-y-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
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
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-3 pb-2">
        <p className="text-muted-foreground px-2 pb-1.5 font-mono text-[10px] font-medium tracking-[0.12em] uppercase">
          Theme
        </p>
        <ThemeSwitcher />
      </div>

      <UserCard />
    </aside>
  );
}
