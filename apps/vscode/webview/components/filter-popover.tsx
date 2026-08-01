/**
 * The filter checkboxes, behind a toolbar icon.
 *
 * The controls themselves come from `@groundplan/canvas` — the same component
 * the canvas's own rail renders — so the panel cannot end up disagreeing with
 * the diagram about what a filter covers. What is different here is where they
 * live: a popover you open, rather than a card holding canvas space open all
 * session for something you touch once.
 */
import { SlidersHorizontal } from "lucide-react";

import {
  categoryCounts,
  categoryOptions,
  changeCounts,
  cn,
  detectHubs,
  FilterControls,
  moduleCounts,
  moduleOptions,
  type Graph,
} from "@groundplan/canvas";

import { strings } from "../strings";
import {
  toCanvasFilters,
  toExclusions,
  type FilterExclusions,
  type FilterOptions,
} from "../state/filters";
import { Popover } from "./popover";

export function FilterButton({
  graph,
  variant,
  options,
  exclusions,
  activeCount,
  open,
  onToggle,
  onClose,
  onChange,
  onClear,
}: Readonly<{
  graph: Graph;
  variant: "plan" | "docs";
  options: FilterOptions;
  exclusions: FilterExclusions;
  activeCount: number;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (next: FilterExclusions) => void;
  onClear: () => void;
}>): React.JSX.Element {
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label={strings.filters.label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={strings.filters.label}
        onClick={onToggle}
        className={cn(
          "flex items-center gap-1 p-1",
          activeCount > 0
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <SlidersHorizontal className="size-3.5" />
        {/* A count, not a dot: "something is filtered" is less useful than
            how much, and the chips row may be collapsed. */}
        {activeCount > 0 && (
          <span className="font-mono text-[10px] tabular-nums">{activeCount}</span>
        )}
      </button>

      <Popover open={open} onClose={onClose} label={strings.filters.label} align="end">
        <FilterControls
          filters={toCanvasFilters(exclusions, options)}
          onChange={(next) => onChange(toExclusions(next, options))}
          onReset={onClear}
          variant={variant}
          categoryOptions={options.categories}
          moduleOptions={options.modules}
          changeCounts={changeCounts(graph)}
          categoryCounts={categoryCounts(graph)}
          moduleCounts={moduleCounts(graph)}
          hasHubs={detectHubs(graph).size > 0}
        />
      </Popover>
    </div>
  );
}

/** What the graph currently offers to filter by. */
export function filterOptionsFor(graph: Graph): FilterOptions {
  return { categories: categoryOptions(graph), modules: moduleOptions(graph) };
}
