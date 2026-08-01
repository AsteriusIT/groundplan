/**
 * What is currently being hidden, and how to stop hiding it.
 *
 * A filter panel you have closed is a filter you have forgotten. The diagram
 * then shows less than the workspace holds with nothing on screen saying so —
 * which is the one thing a diagram claiming to document infrastructure must
 * never do. One chip per active filter, each removable on its own.
 *
 * Not rendered at all when nothing is filtered: an empty row is a permanent
 * strip of chrome that says "no news".
 */
import { X } from "lucide-react";

import { strings } from "../strings";
import type { FilterChip } from "../state/filters";

export function FilterChips({
  chips,
  collapsed = false,
  onRemove,
  onClearAll,
}: Readonly<{
  chips: readonly FilterChip[];
  /** Narrow panel: one chip standing for all of them. */
  collapsed?: boolean;
  onRemove: (chip: FilterChip) => void;
  onClearAll: () => void;
}>): React.JSX.Element | null {
  if (chips.length === 0) return null;

  if (collapsed) {
    return (
      <div className="border-border bg-panel flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <Chip label={strings.filters.active(chips.length)} onRemove={onClearAll} />
      </div>
    );
  }

  return (
    <div className="border-border bg-panel flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          label={chip.label}
          removeLabel={strings.filters.remove(chip.label)}
          onRemove={() => onRemove(chip)}
        />
      ))}
    </div>
  );
}

function Chip({
  label,
  removeLabel,
  onRemove,
}: Readonly<{
  label: string;
  removeLabel?: string;
  onRemove: () => void;
}>): React.JSX.Element {
  return (
    <span className="border-border-strong bg-accent-soft text-foreground flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px]">
      {label}
      <button
        type="button"
        aria-label={removeLabel ?? strings.filters.clearAll}
        title={removeLabel ?? strings.filters.clearAll}
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground flex items-center"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
