import type { IacType } from "@/api/types";
import { IacTypeMark } from "@/components/iac-type-mark";
import { IAC_TYPES } from "@/lib/iac-type";
import { cn } from "@/lib/utils";

const NO_FILES_HINT: Record<IacType, string> = {
  terraform: "No .tf files",
  kubernetes: "No .yaml files",
};

/**
 * The playground's stack switch: which of the two parsers Visualize runs. Both
 * sides always render — the official logomark (unmodified, ICONS.md) beside its
 * label — and a side with no matching files is disabled rather than hidden:
 * the way to a Kubernetes playground is adding a .yaml file, and a control you
 * can see but not press says exactly that.
 */
export function IacSwitch({
  value,
  onChange,
  present,
}: Readonly<{
  value: IacType;
  onChange: (next: IacType) => void;
  /** Which stacks currently have files. */
  present: Record<IacType, boolean>;
}>) {
  return (
    <fieldset
      aria-label="IaC type"
      className="border-border bg-background flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {IAC_TYPES.map(({ id, label }) => {
        const disabled = !present[id];
        return (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            disabled={disabled}
            title={disabled ? NO_FILES_HINT[id] : undefined}
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs transition-colors",
              value === id
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
              disabled && "opacity-50",
            )}
          >
            <IacTypeMark iacType={id} className="size-3.5" />
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
