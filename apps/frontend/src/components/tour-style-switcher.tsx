/**
 * GP-79: how guided tours are shown. Segmented two-way picker, the shape the
 * theme switcher already uses, and — like the theme — it lives on the Settings
 * page and nowhere else.
 *
 * It is a preference rather than a decision because the two chromes answer
 * different questions. "Show me this change" wants the spotlight. "Let me read
 * this change and go back to stop 3" wants the rail.
 */
import { Focus, ListOrdered, type LucideIcon } from "lucide-react";

import { useTourStyle, type TourStyle } from "@/tour/tour-style";
import { cn } from "@/lib/utils";

const OPTIONS: { style: TourStyle; label: string; icon: LucideIcon }[] = [
  { style: "spotlight", label: "Spotlight", icon: Focus },
  { style: "guide", label: "Guide", icon: ListOrdered },
];

export function TourStyleSwitcher({ className }: { className?: string }) {
  const { style, setStyle } = useTourStyle();

  return (
    <div
      role="group"
      aria-label="Tour style"
      className={cn(
        "border-border flex gap-0.5 rounded-md border p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ style: value, label, icon: Icon }) => {
        const active = style === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setStyle(value)}
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
