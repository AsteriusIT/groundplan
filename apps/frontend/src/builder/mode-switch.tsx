/**
 * Edit HCL / Build (GP-133) — the playground's mode switch, in the shape of the
 * stack switch beside it. Rendered only where `BUILDER_ENABLED` is on: a
 * deployment without the builder shows no switch at all, not a disabled one.
 */
import { Code2, Shapes } from "lucide-react";

import { cn } from "@/lib/utils";

export type PlaygroundMode = "edit" | "build";

const MODES: { id: PlaygroundMode; label: string; Icon: typeof Code2 }[] = [
  { id: "edit", label: "Edit HCL", Icon: Code2 },
  { id: "build", label: "Build", Icon: Shapes },
];

export function ModeSwitch({
  value,
  onChange,
}: Readonly<{
  value: PlaygroundMode;
  onChange: (next: PlaygroundMode) => void;
}>) {
  return (
    <fieldset
      aria-label="Playground mode"
      className="border-border bg-background flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {MODES.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs transition-colors",
            value === id
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </fieldset>
  );
}
