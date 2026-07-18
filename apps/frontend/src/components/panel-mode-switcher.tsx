/**
 * How the node details panel sizes itself: one fixed width, or draggable by
 * its left edge. Segmented two-way picker, the shape the theme and tour
 * switchers already use — and like them it lives on the Settings page and
 * nowhere else.
 */
import { PanelRight, UnfoldHorizontal, type LucideIcon } from "lucide-react";

import { usePanelPrefs, type PanelMode } from "@/panel/panel-prefs";
import { cn } from "@/lib/utils";

const OPTIONS: { mode: PanelMode; label: string; icon: LucideIcon }[] = [
  { mode: "fixed", label: "Fixed", icon: PanelRight },
  { mode: "resizable", label: "Resizable", icon: UnfoldHorizontal },
];

export function PanelModeSwitcher({
  className,
}: Readonly<{ className?: string }>) {
  const { mode, setMode } = usePanelPrefs();

  return (
    <fieldset
      aria-label="Details panel sizing"
      className={cn(
        "border-border flex gap-0.5 rounded-md border p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ mode: value, label, icon: Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
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
    </fieldset>
  );
}
