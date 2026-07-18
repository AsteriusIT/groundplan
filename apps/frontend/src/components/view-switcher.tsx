import { useSearchParams } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * The graph views:
 *   `infra`    the default plan-impact / docs canvas (GP-44)
 *   `adapted`  the same graph seen through the accepted annotations (GP-74)
 *   `c4`       the adapted graph collapsed to one node per group (GP-77)
 *   `network`  the vnet/subnet containment view (GP-44)
 *   `iam`      the role-assignment table (GP-48)
 *
 * `adapted` and `c4` are documentation views: they answer "what is this system",
 * which is a question about the repository, not about a pull request.
 */
export type GraphView = "infra" | "adapted" | "c4" | "network" | "iam";

const VIEWS: ReadonlySet<GraphView> = new Set<GraphView>([
  "infra",
  "adapted",
  "c4",
  "network",
  "iam",
]);

/**
 * Read/write the `?view` query param (default "infra"). Kept in the URL — like
 * the `?compare` param — so deep links and share links land on the right view.
 *
 * A view the current graph does not have falls back to `infra` rather than
 * rendering empty: a deep link from a Terraform diagram to `?view=network`, followed
 * on a Kubernetes one, lands on the diagram (the rule GP-99 set for the cluster
 * page). The param is left in the URL untouched — it is simply not read.
 */
export function useGraphView(
  allowed?: readonly GraphView[],
): { view: GraphView; setView: (v: GraphView) => void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view") as GraphView | null;
  const offered = allowed ?? [...VIEWS];
  const view: GraphView =
    raw && VIEWS.has(raw) && offered.includes(raw) ? raw : "infra";
  const setView = (next: GraphView): void => {
    const updated = new URLSearchParams(params);
    if (next === "infra") updated.delete("view");
    else updated.set("view", next);
    setParams(updated, { replace: true });
  };
  return { view, setView };
}

/**
 * The "infra" tab is the same view either way, but it reads differently by
 * context: on a pull request it is the impact of the plan, on the docs page
 * and in the playground it is simply everything the files build.
 */
export type ViewSwitcherVariant = "plan" | "docs" | "playground";

const INFRA_LABEL: Record<ViewSwitcherVariant, string> = {
  plan: "Plan impact",
  docs: "Global",
  playground: "Global",
};

const LABELS: Record<Exclude<GraphView, "infra">, string> = {
  adapted: "Adapted",
  c4: "C4",
  network: "Network",
  iam: "IAM",
};

/**
 * Which lenses a graph can honestly be looked through.
 *
 * Adapted and C4 appear on the docs page only. A pull request asks "what does
 * this change do", and the honest answer to that is the generated graph — an
 * annotation layer that hides and renames things is the wrong lens for reviewing
 * a diff.
 *
 * A **Kubernetes** graph (GP-105) gets the diagram and nothing else. `network`
 * and `iam` read Terraform semantics — vnet containment, Azure role assignments —
 * that a manifest simply does not have, and there is no annotation layer on a
 * Kubernetes snapshot yet, so `adapted` and `c4` would fold over nothing. Drawn
 * anyway they would all be empty, and an empty lens is worse than a missing one:
 * it tells the reader their system has no network and no permissions, which is a
 * lie shaped like information. This is the rule GP-99 set for the cluster page,
 * stated once, where every caller can reach it.
 *
 * The **playground** has no annotation layer, so adapted/c4 would fold over
 * nothing — it gets the docs page's remaining lenses.
 */
export function viewsFor(
  variant: ViewSwitcherVariant,
  kubernetes: boolean,
): GraphView[] {
  if (kubernetes) return ["infra"];
  if (variant === "docs") return ["infra", "adapted", "c4", "network", "iam"];
  // "plan" and "playground" share the set for different reasons: a diff should
  // not be reviewed through the annotation lens; the playground has no lens.
  return ["infra", "network", "iam"];
}

/**
 * The view tabs (GP-44/GP-48/GP-74/GP-77). Underlined-tab styling.
 *
 * With only one view to offer there is nothing to switch, so the switcher removes
 * itself rather than presenting a single tab that does nothing when pressed.
 */
export function ViewSwitcher({
  variant = "plan",
  kubernetes = false,
}: Readonly<{
  variant?: ViewSwitcherVariant;
  kubernetes?: boolean;
}>) {
  const keys = viewsFor(variant, kubernetes);
  const { view, setView } = useGraphView(keys);
  if (keys.length < 2) return null;

  const options = keys.map((key) => ({
    key,
    label: key === "infra" ? INFRA_LABEL[variant] : LABELS[key],
  }));

  return (
    <fieldset className="flex items-center gap-4" aria-label="Graph view">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={view === o.key}
          onClick={() => setView(o.key)}
          className={cn(
            "border-b-2 px-0.5 pb-1.5 font-mono text-xs transition-colors",
            view === o.key
              ? "border-primary text-ink"
              : "border-transparent text-muted-foreground hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
