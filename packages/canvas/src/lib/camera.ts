/**
 * Viewport preservation on snapshot refresh (GP-156): the camera decision as
 * a pure function, so the rule is testable and the component only executes.
 *
 * The rules, in order:
 *  - first layout of a view → fit the whole graph (the only whole-graph fit);
 *  - a refresh that *introduces* changes (the changed ∪ impacted set differs
 *    from the previous snapshot's) → frame the blast radius;
 *  - otherwise, if the previously selected node still exists → re-center on
 *    it at the current zoom (a correction for layout shifts — deterministic
 *    layout means this is usually a no-op);
 *  - otherwise → keep the viewport exactly where the user put it.
 *
 * A repeated diff with the *same* change set deliberately keeps the camera:
 * in the live-diff loop every debounced edit re-diffs, and re-framing the
 * blast radius on each keystroke would fight the user's own pan.
 */
import type { Graph } from "../types";

export type CameraPlan =
  | { kind: "fit-all" }
  | { kind: "fit-changed"; ids: string[] }
  | { kind: "recenter"; id: string }
  | { kind: "keep" };

/** The changed ∪ impacted resource ids — what a diff refresh should frame. */
export function changedFocusIds(graph: Graph): string[] {
  return graph.nodes
    .filter(
      (node) =>
        node.type !== "module" &&
        ((node.change !== null && node.change !== "noop") ||
          node.impacted === true),
    )
    .map((node) => node.id);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function planCamera(args: {
  /** True for the first layout this view instance ever lands. */
  first: boolean;
  graph: Graph;
  /** The previous snapshot's changed ∪ impacted set; null = no previous. */
  prevFocusIds: readonly string[] | null;
  /** What was selected when the refresh started, if anything. */
  prevSelectedId: string | null;
}): CameraPlan {
  if (args.first) return { kind: "fit-all" };

  const ids = changedFocusIds(args.graph);
  if (ids.length > 0 && !sameSet(ids, args.prevFocusIds ?? [])) {
    return { kind: "fit-changed", ids };
  }
  if (
    args.prevSelectedId !== null &&
    args.graph.nodes.some((node) => node.id === args.prevSelectedId)
  ) {
    return { kind: "recenter", id: args.prevSelectedId };
  }
  return { kind: "keep" };
}
