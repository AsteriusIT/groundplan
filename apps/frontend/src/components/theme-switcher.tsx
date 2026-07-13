import { Moon, Ruler, Sun, type LucideIcon } from "lucide-react";

import { useTheme, type Theme } from "@/theme/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Segmented three-way theme picker: light "drafting paper", the cyanotype
 * "blueprint" dark, and the near-neutral "carbon" dark. The active segment is
 * highlighted; each writes through to the shared ThemeProvider.
 *
 * Lives on the Settings page only (GP-69) — the sidebar is for navigation.
 */
const OPTIONS: { theme: Theme; label: string; icon: LucideIcon }[] = [
  { theme: "light", label: "Light", icon: Sun },
  { theme: "blueprint", label: "Blueprint", icon: Ruler },
  { theme: "carbon", label: "Carbon", icon: Moon },
];

export function ThemeSwitcher({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn(
        "border-border flex gap-0.5 rounded-md border p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ theme: value, label, icon: Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={active}
            title={label}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-sm py-1.5 transition-colors",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
