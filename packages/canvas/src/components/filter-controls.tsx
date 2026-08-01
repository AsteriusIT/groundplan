/**
 * The filter checkboxes, as a component two hosts can render.
 *
 * The canvas keeps them in its left rail; the VS Code panel puts them in a
 * popover behind a toolbar icon. What a filter *is* — which sets exist, what
 * each option covers, that unticking has a visible cost — is the same in both,
 * and two copies of that would drift the first time a filter was added.
 *
 * Presentational and fully controlled: it holds no state and knows nothing
 * about who owns the sets it renders.
 */
import { RotateCcw, Waypoints } from "lucide-react";

import { FILTER_LABELS, FILTER_SWATCH } from "../lib/legend";
import { ALL_FILTERS, type FilterKey } from "../lib/graph-layout";
import { CATEGORY_META, type Category } from "../lib/resource-category";
import { cn } from "../lib/utils";
import type { CanvasFilters } from "./graph-canvas";

function FilterSection({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="text-muted-foreground mb-1 font-mono text-[10px] tracking-wide uppercase">
        {title}
      </p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function CheckRow({
  checked,
  onToggle,
  count,
  children,
}: Readonly<{
  checked: boolean;
  onToggle: () => void;
  /** How many resources this option covers — what unticking it will cost you. */
  count?: number;
  children: React.ReactNode;
}>) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-primary size-3.5"
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {count !== undefined && (
        <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
          {count}
        </span>
      )}
    </label>
  );
}

function toggle<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function FilterControls({
  filters,
  onChange,
  onReset,
  variant,
  categoryOptions,
  moduleOptions,
  changeCounts,
  categoryCounts,
  moduleCounts,
  hasHubs,
}: Readonly<{
  filters: CanvasFilters;
  onChange: (next: CanvasFilters) => void;
  onReset: () => void;
  /** `docs` snapshots have no change data, so the change filters would do nothing. */
  variant: "plan" | "docs";
  categoryOptions: readonly Category[];
  moduleOptions: readonly string[];
  changeCounts: ReadonlyMap<FilterKey, number>;
  categoryCounts: ReadonlyMap<Category, number>;
  moduleCounts: ReadonlyMap<string, number>;
  hasHubs: boolean;
}>): React.JSX.Element {
  return (
    <>
      {variant === "plan" && (
        <FilterSection title="Change">
          {ALL_FILTERS.map((key) => (
            <CheckRow
              key={key}
              checked={filters.change.has(key)}
              count={changeCounts.get(key) ?? 0}
              onToggle={() =>
                onChange({ ...filters, change: toggle(filters.change, key) })
              }
            >
              <span className={cn("size-2.5 rounded-xs", FILTER_SWATCH[key])} />
              {FILTER_LABELS[key]}
            </CheckRow>
          ))}
        </FilterSection>
      )}

      {categoryOptions.length > 0 && (
        <FilterSection title="Category">
          {categoryOptions.map((cat) => {
            const meta = CATEGORY_META[cat];
            return (
              <CheckRow
                key={cat}
                checked={filters.categories.has(cat)}
                count={categoryCounts.get(cat) ?? 0}
                onToggle={() =>
                  onChange({
                    ...filters,
                    categories: toggle<Category>(filters.categories, cat),
                  })
                }
              >
                <meta.icon className={cn("size-3", meta.className)} />
                {meta.label}
              </CheckRow>
            );
          })}
        </FilterSection>
      )}

      {/* One option is not a choice: a lone "root" box would only ever hide the
          entire diagram. A Kubernetes graph is always this (a manifest has no
          modules), and so is a Terraform repository that never wrote one — but
          the set still covers them, or the dim pass would hide what no checkbox
          could bring back. */}
      {moduleOptions.length > 1 && (
        <FilterSection title="Module">
          {moduleOptions.map((mod) => (
            <CheckRow
              key={mod}
              checked={filters.modules.has(mod)}
              count={moduleCounts.get(mod) ?? 0}
              onToggle={() =>
                onChange({ ...filters, modules: toggle(filters.modules, mod) })
              }
            >
              <span className="truncate">{mod}</span>
            </CheckRow>
          ))}
        </FilterSection>
      )}

      {/* GP-35: hub edges are hidden by default; this restores them all. */}
      {hasHubs && (
        <FilterSection title="Connections">
          <CheckRow
            checked={filters.hubEdges}
            onToggle={() => onChange({ ...filters, hubEdges: !filters.hubEdges })}
          >
            <Waypoints className="text-muted-foreground size-3" />
            Show hub connections
          </CheckRow>
        </FilterSection>
      )}

      <button
        type="button"
        onClick={onReset}
        className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 border-t border-border pt-2 text-[10px]"
      >
        <RotateCcw className="size-3" />
        Reset
      </button>
    </>
  );
}
