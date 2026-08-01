/**
 * The panel remembers which filters are *off*, not which are on.
 *
 * A stored "on" set is a promise about a graph that has since changed: a module
 * that no longer exists, a category nothing is in any more. Restoring it would
 * hide resources no checkbox could bring back. Stored as exclusions, a
 * vanished option simply stops excluding anything.
 */
import { describe, expect, test } from "vitest";
import type { Category } from "@groundplan/canvas";

import {
  NO_EXCLUSIONS,
  activeFilterChips,
  toCanvasFilters,
  toExclusions,
} from "./filters";

const OPTIONS = {
  categories: ["network", "compute"] as Category[],
  modules: ["root", "net"],
};

describe("toCanvasFilters", () => {
  test("everything is on when nothing is excluded", () => {
    const filters = toCanvasFilters(NO_EXCLUSIONS, OPTIONS);

    expect([...filters.change]).toContain("create");
    expect([...filters.categories].sort()).toEqual(["compute", "network"]);
    expect([...filters.modules].sort()).toEqual(["net", "root"]);
    expect(filters.hubEdges).toBe(false);
  });

  test("an excluded option is off", () => {
    const filters = toCanvasFilters(
      { ...NO_EXCLUSIONS, change: new Set(["create"]) },
      OPTIONS,
    );

    expect(filters.change.has("create")).toBe(false);
    expect(filters.change.has("update")).toBe(true);
  });

  test("an exclusion for something that no longer exists excludes nothing", () => {
    // The stack was re-parsed and `module.legacy` is gone. A stored "on" set
    // would have hidden everything it did not list; this hides nothing.
    const filters = toCanvasFilters(
      { ...NO_EXCLUSIONS, modules: new Set(["legacy"]) },
      OPTIONS,
    );

    expect([...filters.modules].sort()).toEqual(["net", "root"]);
  });

  test("hub edges ride along as the one plain flag", () => {
    const filters = toCanvasFilters({ ...NO_EXCLUSIONS, hubEdges: true }, OPTIONS);

    expect(filters.hubEdges).toBe(true);
  });
});

describe("toExclusions", () => {
  test("turns what the canvas reports back into what is off", () => {
    const exclusions = toExclusions(
      {
        change: new Set(["update", "delete", "noop", "impacted"]),
        categories: new Set<Category>(["network"]),
        modules: new Set(["root", "net"]),
        hubEdges: true,
      },
      OPTIONS,
    );

    expect([...exclusions.change]).toEqual(["create"]);
    expect([...exclusions.categories]).toEqual(["compute"]);
    expect([...exclusions.modules]).toEqual([]);
    expect(exclusions.hubEdges).toBe(true);
  });

  test("round-trips through the canvas's own shape", () => {
    const before = {
      ...NO_EXCLUSIONS,
      change: new Set<"create">(["create"]),
      categories: new Set<Category>(["compute"]),
    };

    const after = toExclusions(toCanvasFilters(before, OPTIONS), OPTIONS);

    expect([...after.change]).toEqual(["create"]);
    expect([...after.categories]).toEqual(["compute"]);
  });
});

describe("activeFilterChips", () => {
  test("there are no chips when nothing is filtered", () => {
    expect(activeFilterChips(NO_EXCLUSIONS, OPTIONS)).toEqual([]);
  });

  test("one chip per thing being hidden, named for the reader", () => {
    const chips = activeFilterChips(
      {
        change: new Set(["create"]),
        categories: new Set<Category>(["compute"]),
        modules: new Set(["net"]),
        hubEdges: false,
      },
      OPTIONS,
    );

    expect(chips.map((c) => c.label)).toEqual(["Create", "Compute", "net"]);
  });

  test("hub connections are a chip too — it is a filter like any other", () => {
    const chips = activeFilterChips({ ...NO_EXCLUSIONS, hubEdges: true }, OPTIONS);

    expect(chips).toHaveLength(1);
    expect(chips[0]?.label).toMatch(/hub/i);
  });

  test("a chip for an option the graph no longer has is not shown", () => {
    // It is excluding nothing, so offering to un-exclude it is a lie.
    const chips = activeFilterChips(
      { ...NO_EXCLUSIONS, modules: new Set(["legacy"]) },
      OPTIONS,
    );

    expect(chips).toEqual([]);
  });

  test("each chip knows how to undo itself", () => {
    const exclusions = { ...NO_EXCLUSIONS, change: new Set<"create">(["create"]) };

    const chips = activeFilterChips(exclusions, OPTIONS);
    const restored = chips[0]!.without(exclusions);

    expect([...restored.change]).toEqual([]);
  });
});
