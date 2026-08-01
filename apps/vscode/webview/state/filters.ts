/**
 * Which filters the panel is under, stored as what is *excluded*.
 *
 * The canvas thinks in terms of what is on: four sets of everything currently
 * shown. That is the right shape to dim a diagram with and the wrong shape to
 * remember, because it is a promise about a graph that has since changed. A
 * stored "on" set that predates a re-parse hides every module added since, and
 * no checkbox can bring them back — the reader has no way to know what they are
 * not being shown. Exclusions fail the other way: an option that no longer
 * exists simply stops excluding anything.
 */
import {
  ALL_FILTERS,
  CATEGORY_META,
  FILTER_LABELS,
  type CanvasFilters,
  type Category,
  type FilterKey,
} from "@groundplan/canvas";

/** What the graph currently offers to filter by. */
export type FilterOptions = {
  categories: readonly Category[];
  modules: readonly string[];
};

export type FilterExclusions = {
  change: ReadonlySet<FilterKey>;
  categories: ReadonlySet<Category>;
  modules: ReadonlySet<string>;
  /** Not an exclusion: hub edges are hidden by default and this reveals them. */
  hubEdges: boolean;
};

export const NO_EXCLUSIONS: FilterExclusions = {
  change: new Set(),
  categories: new Set(),
  modules: new Set(),
  hubEdges: false,
};

function keep<T>(options: readonly T[], excluded: ReadonlySet<T>): Set<T> {
  return new Set(options.filter((option) => !excluded.has(option)));
}

/** What the canvas should be dimmed by, given the graph it is drawing. */
export function toCanvasFilters(
  exclusions: FilterExclusions,
  options: FilterOptions,
): CanvasFilters {
  return {
    change: keep(ALL_FILTERS, exclusions.change),
    categories: keep(options.categories, exclusions.categories),
    modules: keep(options.modules, exclusions.modules),
    hubEdges: exclusions.hubEdges,
  };
}

/** The inverse: what the canvas reports back, as what is off. */
export function toExclusions(
  filters: CanvasFilters,
  options: FilterOptions,
): FilterExclusions {
  return {
    change: new Set(ALL_FILTERS.filter((key) => !filters.change.has(key))),
    categories: new Set(
      options.categories.filter((cat) => !filters.categories.has(cat)),
    ),
    modules: new Set(options.modules.filter((mod) => !filters.modules.has(mod))),
    hubEdges: filters.hubEdges,
  };
}

/**
 * One chip per filter that is actually doing something. A chip for an option
 * the graph no longer has would be offering to undo an effect that does not
 * exist, so those are dropped — the same reason the exclusions are stored this
 * way round.
 */
export type FilterChip = {
  id: string;
  label: string;
  /** These exclusions with this chip's filter lifted. */
  without: (exclusions: FilterExclusions) => FilterExclusions;
};

function drop<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

export function activeFilterChips(
  exclusions: FilterExclusions,
  options: FilterOptions,
): FilterChip[] {
  const chips: FilterChip[] = [];

  for (const key of ALL_FILTERS) {
    if (!exclusions.change.has(key)) continue;
    chips.push({
      id: `change:${key}`,
      label: FILTER_LABELS[key],
      without: (current) => ({ ...current, change: drop(current.change, key) }),
    });
  }

  for (const cat of options.categories) {
    if (!exclusions.categories.has(cat)) continue;
    chips.push({
      id: `category:${cat}`,
      label: CATEGORY_META[cat].label,
      without: (current) => ({
        ...current,
        categories: drop(current.categories, cat),
      }),
    });
  }

  for (const mod of options.modules) {
    if (!exclusions.modules.has(mod)) continue;
    chips.push({
      id: `module:${mod}`,
      label: mod,
      without: (current) => ({ ...current, modules: drop(current.modules, mod) }),
    });
  }

  if (exclusions.hubEdges) {
    chips.push({
      id: "hub-edges",
      label: "Hub connections",
      without: (current) => ({ ...current, hubEdges: false }),
    });
  }

  return chips;
}
